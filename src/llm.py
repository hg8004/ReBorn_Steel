"""
Claude API 호출을 한 곳에 모은 파일.

- API 키는 환경변수 ANTHROPIC_API_KEY에서 읽는다 (코드에 키를 적지 않는다).
- 키가 없으면 llm_available()이 False가 되고, 각 도구는 규칙 기반 대체 로직을 쓴다.
- 같은 입력에 대한 LLM 응답은 outputs/cache/에 저장해 두고 다시 쓴다.
  → 평가를 다시 돌려도 결과가 같고, API 비용도 아낀다.
"""
import hashlib
import json
import os

from config import LLM_MODEL, OUTPUT_DIR

CACHE_DIR = OUTPUT_DIR / "cache"
_client = None


def llm_available():
    if os.environ.get("REBORN_NO_LLM") == "1":     # 강제로 끄고 싶을 때
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic()
    return _client


def create_message(**kwargs):
    """
    Claude 메시지 API 호출.
    안전 분류기가 요청을 거절하면(refusal) 서버가 자동으로 다른 모델로 넘겨주도록
    server-side fallback 기능을 켜 둔다.
    """
    return client().beta.messages.create(
        model=LLM_MODEL,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        **kwargs,
    )


def ask_json(system, user, schema, cache_key, effort="medium"):
    """
    Claude에게 JSON 형식으로 답을 받는다 (structured outputs: 스키마를 반드시 지킴).
    cache_key가 같으면 저장된 답을 그대로 돌려준다.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256((system + user + json.dumps(schema, sort_keys=True)).encode()).hexdigest()[:12]
    path = CACHE_DIR / f"{cache_key}_{h}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))

    resp = create_message(
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"effort": effort,
                       "format": {"type": "json_schema", "schema": schema}},
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("LLM이 요청을 거절했습니다.")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("LLM 응답이 max_tokens에서 잘렸습니다.")
    text = next(b.text for b in resp.content if b.type == "text")
    data = json.loads(text)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data
