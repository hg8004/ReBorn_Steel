"""
배합 AI 에이전트 (오케스트레이터)    실행: python src/agent.py --date 2026-09-25

프레임워크 없이 Claude API의 tool use 기능을 직접 쓴다.
  1) Claude에게 '오늘 배합 지시서를 만들라'는 과제와 도구 6개의 설명을 준다.
  2) Claude가 도구 호출을 요청하면(stop_reason == "tool_use") 파이썬이 그 도구를 실행하고
     결과를 돌려준다.
  3) Claude가 결과를 보고 다음 행동(어떤 도구를, 어떤 안전여유로)을 스스로 고른다.
     특히 시뮬레이션 결과가 목표(2%)를 넘으면 안전여유를 키워 최적화로 되돌아간다.
  4) Claude가 더 이상 도구를 부르지 않으면(end_turn) 끝.

API 키(ANTHROPIC_API_KEY)가 없으면 같은 도구를 정해진 순서로 부르는 pipeline.run_full로 대신한다.

숫자는 전부 도구(파이썬)가 계산한다. 큰 표는 파이썬 쪽 state에 두고 LLM에는 요약만 보여준다.
"""
import argparse
import json
import sys
import time

from config import MAX_ITERATIONS, OUTPUT_DIR, STEELS, TARGET_FAIL_PROB
from llm import create_message, llm_available
from pipeline import expert_blend, initial_margins, run_full
from tools import (estimate_composition, load_context, optimize_blend,
                   parse_inspection_notes, render_text, simulate_heat,
                   suggest_margins, summarize_context, summarize_for_llm,
                   summarize_sim, to_constraints, write_charge_sheet)
from tools.common import available_dates

GRADE_ENUM = ["HS_A", "HS_B", "HMS_A", "HMS_B", "LS_A", "LS_B", "SHR", "TRN"]
MARGIN_SCHEMA = {
    "type": "object",
    "properties": {s: {"type": "object",
                       "properties": {"cu": {"type": "number"}, "sn": {"type": "number"}},
                       "required": ["cu", "sn"], "additionalProperties": False}
                   for s in STEELS},
    "required": STEELS, "additionalProperties": False,
}


def _tool(name, desc, props=None, required=None):
    return {"name": name, "description": desc, "strict": True,
            "input_schema": {"type": "object", "properties": props or {},
                             "required": required or [], "additionalProperties": False}}


TOOLS = [
    _tool("load_context", "당일 생산 계획(heat 수, 강종), 스크랩 등급별 시세·재고, 강종별 Cu·Sn 상한을 조회한다."),
    _tool("parse_inspection_notes",
          "당일 스크랩 검수 메모를 분석해 Cu·Sn 위험 로트를 판정한다. "
          "high는 오늘 배합에서 제외, medium은 장입 비율 5% 이하로 제한된다."),
    _tool("estimate_composition",
          "과거 500 heat 조업 이력을 회귀 분석해 등급별 실제 Cu·Sn 평균·표준편차를 추정한다. "
          "공칭값과의 차이와 첫 안전여유 제안값을 함께 돌려준다."),
    _tool("optimize_blend",
          "선형계획법으로 하루 전체 heat의 원가 최소 배합을 계산한다. "
          "margins는 강종별 Cu·Sn 안전여유(단위 %, 상한에서 이만큼 뺀 값을 목표로 함).",
          {"margins": MARGIN_SCHEMA,
           "apply_note_constraints": {"type": "boolean",
                                      "description": "검수 메모 분석 결과(제외·제한)를 반영할지"}},
          ["margins", "apply_note_constraints"]),
    _tool("simulate_heat",
          "가장 최근 optimize_blend 결과를 몬테카를로 1,000회로 모의 조업해 heat별 규격 이탈 확률을 "
          "계산한다. 목표를 넘은 강종에 대해 안전여유 조정 제안값(suggested_margins)을 준다."),
    _tool("write_charge_sheet",
          "시뮬레이션을 통과한 최종 배합으로 배합 지시서와 판단 근거를 작성한다. 마지막에 한 번 호출한다."),
]

SYSTEM = f"""당신은 전기로 제강사 리본스틸(가상 기업)의 스크랩 배합 AI 에이전트입니다.
목표: 오늘 생산 계획의 모든 heat에 대해, 규격 이탈 확률을 heat마다 {TARGET_FAIL_PROB:.0%} 이하로 지키면서
톤당 배합 원가가 가장 낮은 스크랩 배합을 정하고 배합 지시서를 냅니다.

작업 방법
- 도구를 써서 오늘 조건, 검수 메모, 등급별 실제 성분을 먼저 파악하세요.
- optimize_blend 다음에는 반드시 simulate_heat로 검증하세요.
- 시뮬레이션에서 목표를 넘은 강종이 있으면 그 강종의 안전여유를 키워 다시 최적화하세요.
  suggested_margins를 참고하되 판단은 직접 하세요. 통과한 강종의 여유를 불필요하게 키우면 원가가 오릅니다.
- 최적화-시뮬레이션은 최대 {MAX_ITERATIONS}회까지 반복합니다.
- 통과하면 write_charge_sheet를 호출하고, 마지막에 무엇을 근거로 어떻게 결정했는지 3~5문장으로 한국어로 요약하세요.
- 숫자는 도구 결과에 있는 값만 쓰고 지어내지 마세요."""


class AgentState:
    """도구 실행에 필요한 큰 데이터(표, 배합 행렬)를 들고 있는 상자"""

    def __init__(self, date, use_llm_tools=True):
        self.date = date
        self.use_llm_tools = use_llm_tools
        self.ctx = self.comp = self.parsed = self.nc = None
        self.opt = self.sim = self.margins = None
        self._used_nc = None
        self.iterations = 0
        self.sheet = None
        self.trace = []

    # ---- 도구 실행 -------------------------------------------------
    def run(self, name, args):
        fn = getattr(self, f"t_{name}", None)
        if fn is None:
            raise ValueError(f"알 수 없는 도구: {name}")
        return fn(**args)

    def t_load_context(self):
        self.ctx = load_context(self.date)
        return summarize_context(self.ctx)

    def t_parse_inspection_notes(self):
        self.parsed = parse_inspection_notes(self.date, use_llm=self.use_llm_tools)
        self.nc = to_constraints(self.parsed)
        return {"method": self.parsed["method"], "notes": self.parsed["notes"],
                "flags": self.parsed["flags"],
                "constraints": {"exclude": self.nc["exclude"], "cap_pct": self.nc["cap_pct"]}}

    def t_estimate_composition(self):
        self._need_ctx()
        self.comp = estimate_composition()
        g = {k: {"cu_mean": round(v["cu_mean"], 3), "cu_sd": round(v["cu_sd"], 3),
                 "nominal_cu": v["nominal_cu"], "sn_mean": round(v["sn_mean"], 4),
                 "sn_sd": round(v["sn_sd"], 4), "nominal_sn": v["nominal_sn"]}
             for k, v in self.comp["grades"].items()}
        return {"grades": g, "n_heats": self.comp["n_heats"],
                "outlier_dates": self.comp["outlier_dates"],
                "initial_margin_suggestion": initial_margins(self.ctx, self.comp)}

    def t_optimize_blend(self, margins, apply_note_constraints):
        self._need_ctx()
        if self.comp is None:
            return {"error": "먼저 estimate_composition을 호출하세요."}
        if self.iterations >= MAX_ITERATIONS:
            return {"error": f"최대 반복 횟수({MAX_ITERATIONS})에 도달했습니다. 마지막 결과로 지시서를 쓰세요."}
        nc = self.nc if apply_note_constraints else None
        opt = optimize_blend(self.ctx, self.comp, margins, nc)
        self.iterations += 1
        if opt["status"] == "ok":
            self.opt, self.margins, self.sim = opt, margins, None
            self._used_nc = nc
        return summarize_for_llm(opt) | {"iteration": self.iterations}

    def t_simulate_heat(self):
        if self.opt is None:
            return {"error": "먼저 optimize_blend를 호출하세요."}
        mult = self._used_nc["multiplier"] if self._used_nc else None
        self.sim = simulate_heat(self.ctx, self.opt["x"], self.comp, multiplier=mult,
                                 seed=self.iterations)
        sug, _ = suggest_margins(self.sim, self.ctx["specs"], self.margins)
        return summarize_sim(self.sim) | {"current_margins": self.margins, "suggested_margins": sug}

    def t_write_charge_sheet(self):
        if self.sim is None:
            return {"error": "최신 배합에 대한 simulate_heat 결과가 없습니다."}
        base = expert_blend(self.ctx, self.comp)
        self.sheet = write_charge_sheet(self.ctx, self.opt, self.sim, base, self.parsed,
                                        self.margins, self.iterations, use_llm=self.use_llm_tools)
        f = self.sheet["summary"]
        return {"ok": True, "cost_per_t": f["cost_per_t"], "expert_cost_per_t": f["expert_cost_per_t"],
                "saving_per_t": f["saving_per_t"], "heats": len(self.sheet["heats"])}

    def _need_ctx(self):
        if self.ctx is None:
            self.ctx = load_context(self.date)


def run_agent(date, max_turns=25, verbose=True):
    """Claude가 도구를 골라 쓰는 에이전트 루프 (수동 루프)"""
    state = AgentState(date)
    messages = [{"role": "user",
                 "content": f"{date} 생산 계획에 대한 스크랩 배합 지시서를 만들어 주세요."}]
    final_text = ""
    for turn in range(max_turns):
        resp = create_message(max_tokens=16000, system=SYSTEM, tools=TOOLS, messages=messages,
                              output_config={"effort": "medium"})
        messages.append({"role": "assistant", "content": resp.content})
        for b in resp.content:
            if b.type == "text" and b.text.strip():
                final_text = b.text
                if verbose:
                    print(f"\n[에이전트] {b.text}")
        if resp.stop_reason == "refusal":
            print("LLM이 요청을 거절했습니다."); break
        if resp.stop_reason != "tool_use":
            break

        results = []
        for b in resp.content:
            if b.type != "tool_use":
                continue
            if verbose:
                print(f"  → 도구 호출: {b.name}({json.dumps(b.input, ensure_ascii=False)})")
            try:
                out = state.run(b.name, b.input)
                is_err = "error" in out
            except Exception as e:          # 도구 오류는 LLM에게 알려서 스스로 고치게 한다
                out, is_err = {"error": str(e)}, True
            state.trace.append({"turn": turn, "tool": b.name, "input": b.input, "output": out})
            results.append({"type": "tool_result", "tool_use_id": b.id,
                            "content": json.dumps(out, ensure_ascii=False, default=float),
                            "is_error": is_err})
        messages.append({"role": "user", "content": results})   # 결과는 한 메시지에 모아서 보낸다
    return state, final_text


def main():
    ap = argparse.ArgumentParser(description="리본스틸 배합 AI 에이전트")
    ap.add_argument("--date", default=None, help="배합할 날짜 (예: 2026-09-25)")
    ap.add_argument("--show", type=int, default=6, help="화면에 보여줄 heat 수")
    args = ap.parse_args()
    dates = available_dates()
    date = args.date or dates[0]
    if date not in dates:
        print(f"가능한 날짜: {dates[0]} ~ {dates[-1]}"); return 1

    t0 = time.perf_counter()
    if llm_available():
        print(f"=== Claude 에이전트 실행: {date} ===")
        state, summary = run_agent(date)
        sheet = state.sheet
        if sheet is None:
            print("에이전트가 지시서를 만들지 못했습니다."); return 1
        sheet["agent_summary"] = summary
        sheet["trace"] = state.trace
    else:
        print(f"=== API 키가 없어 정해진 순서(pipeline)로 실행: {date} ===")
        sheet = run_full(date, use_llm=False)
        print("\n".join(sheet["log"]))
    sheet["seconds"] = round(time.perf_counter() - t0, 1)

    print("\n" + render_text(sheet, max_heats=args.show))
    print(f"(소요 시간 {sheet['seconds']}초, 전체 {len(sheet['heats'])} heat 중 {args.show}개 표시)")
    out = OUTPUT_DIR / "agent_runs"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{date}.json").write_text(json.dumps(sheet, ensure_ascii=False, indent=1, default=float),
                                      encoding="utf-8")
    print(f"저장: {out / (date + '.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
