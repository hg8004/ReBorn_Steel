"""
도구 1. load_context — 당일 생산 계획, 재고, 시세 조회 (단순 데이터 조회)
"""
from tools.common import market, production_plan, scrap_table, specs_table


def load_context(date):
    """
    배합 설계에 필요한 '오늘의 조건'을 한 묶음으로 돌려준다.

    반환값(dict)
      date      : 날짜
      plan      : 생산 계획 DataFrame (heat_id, steel_grade, target_tap_weight_t)
      scrap     : 등급 공칭값 + 당일 단가·재고가 합쳐진 DataFrame
      specs     : 강종별 성분 상한 DataFrame
    """
    scrap = scrap_table().copy()
    day = market(date)
    scrap["price_krw_per_t"] = day["price_krw_per_t"]   # 카탈로그 단가 대신 당일 시세
    scrap["inventory_t"] = day["inventory_t"]
    plan = production_plan().copy()
    return {"date": date, "plan": plan, "scrap": scrap, "specs": specs_table()}


def summarize_context(ctx):
    """LLM에게 보여줄 짧은 요약 (표 전체 대신 핵심만)"""
    plan = ctx["plan"]
    s = ctx["scrap"]
    need = plan["target_tap_weight_t"].sum()
    return {
        "date": ctx["date"],
        "heats": len(plan),
        "heats_by_steel": plan["steel_grade"].value_counts().to_dict(),
        "total_target_tap_t": float(need),
        "scrap": [
            {"grade_id": g, "name_kr": r["name_kr"], "price_krw_per_t": int(r["price_krw_per_t"]),
             "inventory_t": int(r["inventory_t"]), "yield": r["yield"]}
            for g, r in s.iterrows()
        ],
        "specs": ctx["specs"].reset_index().to_dict(orient="records"),
    }
