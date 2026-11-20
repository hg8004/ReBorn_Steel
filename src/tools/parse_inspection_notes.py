"""
도구 2. parse_inspection_notes — 검수 메모(비정형 텍스트)에서 위험 로트를 뽑아
         '배합 제약'으로 바꾼다.  (LLM 사용, 키가 없으면 키워드 규칙으로 대체)

출력 예
  [{"lot_id": "LS_A-20260925", "grade_id": "LS_A", "element": "cu",
    "risk": "high", "suspected_multiplier": 2.0, "reason": "모터·전선 혼입 다수"}]

risk가 high인 로트 → 오늘 배합에서 제외 (장입량 상한 0)
risk가 medium인 로트 → 장입 비율 5% 이하로 제한 + 시뮬레이션에서 성분을 높게 가정
"""
import json

from llm import ask_json, llm_available
from tools.common import notes as read_notes

SYSTEM = """당신은 전기로 제강사의 스크랩 검수 메모를 분석하는 품질 엔지니어입니다.
Cu(구리)와 Sn(주석)은 전기로·LF 정련으로 제거되지 않으므로 스크랩 단계에서 막아야 합니다.
각 메모를 읽고, 그 로트의 Cu 또는 Sn 함량이 평소보다 높을 위험이 있는지 판단하세요.

판단 기준
- high: Cu·Sn 원천(모터, 전선, 구리코일, 황동, 주석도금 캔, 비철 선별 불량 등)이
  실제로 혼입되었다고 적혀 있음
- medium: 혼입 가능성이 언급되었지만 확실하지 않음
- none: 특이사항 없음, 유분·수분·녹·부피처럼 Cu·Sn과 무관한 내용,
  또는 위험 단어가 있어도 '제거 완료', '분석 결과 정상'처럼 해소되었다고 적힌 경우

suspected_multiplier는 평소 함량 대비 몇 배로 추정되는지입니다 (none이면 1.0).
모든 메모에 대해 하나씩 답하세요."""

SCHEMA = {
    "type": "object",
    "properties": {
        "flags": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "lot_id": {"type": "string"},
                    "grade_id": {"type": "string"},
                    "element": {"type": "string", "enum": ["cu", "sn", "none"]},
                    "risk": {"type": "string", "enum": ["high", "medium", "none"]},
                    "suspected_multiplier": {"type": "number"},
                    "reason": {"type": "string"},
                },
                "required": ["lot_id", "grade_id", "element", "risk",
                             "suspected_multiplier", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["flags"],
    "additionalProperties": False,
}

# 키워드 규칙 (LLM이 없을 때 쓰는 대체 로직). 문맥을 못 읽으므로 '제거 완료' 같은 말에 속는다.
CU_WORDS = ["cu", "구리", "전선", "모터", "황동", "비철", "코일"]
SN_WORDS = ["sn", "주석", "캔"]


def _keyword_parse(df):
    flags = []
    for _, r in df.iterrows():
        t = r["note_text"].lower()
        elem = "none"
        if any(w in t for w in CU_WORDS):
            elem = "cu"
        elif any(w in t for w in SN_WORDS):
            elem = "sn"
        flags.append({
            "lot_id": r["lot_id"], "grade_id": r["grade_id"], "element": elem,
            "risk": "high" if elem != "none" else "none",
            "suspected_multiplier": 2.0 if elem != "none" else 1.0,
            "reason": f"키워드 규칙: '{r['note_text']}'",
        })
    return flags


def parse_inspection_notes(date, use_llm=None):
    """
    해당 날짜 검수 메모를 분석한다.
    반환: {"date", "method": "llm"|"keyword", "notes": [...원문...], "flags": [...]}
    """
    df = read_notes(date)
    if use_llm is None:
        use_llm = llm_available()
    raw = df[["lot_id", "grade_id", "note_text"]].to_dict(orient="records")
    if df.empty:
        return {"date": date, "method": "none", "notes": [], "flags": []}

    if use_llm:
        user = "오늘 검수 메모 목록(JSON):\n" + json.dumps(raw, ensure_ascii=False, indent=1)
        out = ask_json(SYSTEM, user, SCHEMA, cache_key=f"notes_{date}")
        flags, method = out["flags"], "llm"
    else:
        flags, method = _keyword_parse(df), "keyword"

    # 등급 ID 형식이 이상한 답이 섞이지 않도록 원문 로트와 맞춰서 정리
    valid = {r["lot_id"]: r["grade_id"] for r in raw}
    clean = []
    for f in flags:
        if f["lot_id"] in valid:
            f["grade_id"] = valid[f["lot_id"]]
            f["suspected_multiplier"] = float(min(max(f["suspected_multiplier"], 1.0), 4.0))
            clean.append(f)
    return {"date": date, "method": method, "notes": raw, "flags": clean}


def to_constraints(parsed):
    """
    분석 결과를 최적화·시뮬레이션이 쓰는 제약 형태로 바꾼다.
      exclude : 오늘 쓰지 않을 등급 (risk high)
      cap_pct : 장입 비율 상한 (risk medium → 5%)
      multiplier : 시뮬레이션에서 성분에 곱할 배수 {(grade, element): 배수}
    """
    exclude, cap, mult = [], {}, {}
    for f in parsed["flags"]:
        if f["risk"] == "high":
            exclude.append(f["grade_id"])
        elif f["risk"] == "medium":
            cap[f["grade_id"]] = 0.05
        if f["risk"] != "none" and f["element"] in ("cu", "sn"):
            mult[(f["grade_id"], f["element"])] = f["suspected_multiplier"]
    return {"exclude": sorted(set(exclude)), "cap_pct": cap, "multiplier": mult}
