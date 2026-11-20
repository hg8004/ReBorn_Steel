/* 리본스틸 사내 포털 공통 스크립트
   - 접속자 = 이 과제의 직무(제강팀 스크랩 배합 담당)에 배정된 '신입사원'.
     처음 접속하면 이름을 묻고, 그 이름으로 사내 메일함과 할 일을 만든다.
   - 사내 메일: 그날의 배합 지시서(results.js)와 회사 데이터(company.js)에서
     신입 배합 담당이 받아야 할 메일과 할 일을 만든다.
   - 상단 바, 왼쪽 메뉴, 입사(이름 입력) 창, 툴팁, 선 그래프
   ※ 숨은 정답(ground truth)에서 온 값(정답 기준 이탈률, 이상 로트 날짜)은 쓰지 않는다.
     회사 직원이 실제로 알 수 있는 정보만 보여준다. */
(function () {
  "use strict";
  var D = window.REBORN_DATA, C = window.REBORN_COMPANY;

  var GRADES = ["HS_A", "HS_B", "HMS_A", "HMS_B", "LS_A", "LS_B", "SHR", "TRN"];
  var GNAME = { HS_A: "생철A", HS_B: "생철B", HMS_A: "중량A", HMS_B: "중량B", LS_A: "경량A", LS_B: "경량B", SHR: "슈레디드", TRN: "선반설" };
  var GCOL = { HS_A: "--s1", HS_B: "--s2", HMS_A: "--s3", HMS_B: "--s4", LS_A: "--s5", LS_B: "--s6", SHR: "--s7", TRN: "--s8" };
  var SHORT_T = 250;            // 재고 부족 기준 (write_charge_sheet.py와 같은 값)
  var PROFILE_IMG = "assets/rebo-face.png";
  var BRAND = "assets/brand/";
  var NAME_MAX = 12;

  /* ---------- timelyGPT (리보 AI 채팅) 설정 ----------
     chatUrl: timelyai.io에 만든 리본스틸 스페이스. 지난 기록·미션 화면에서 결과 요약을 복사해 이 채팅에 붙여 넣는다 (기본 방식, 키 불필요).
     아래 SDK 연동은 'TimelyChat SDK용 API 키'(ai.timelygpt.co.kr)가 있을 때만 동작한다.
     timelyai.io에서 받은 키로는 "해당하는 조직을 찾을 수 없습니다"가 나온다 (2026-11 확인).
     API 키는 코드에 적지 않는다. 입력하면 로그인에만 쓰고 버리며, 받은 토큰(24시간)만 이 창(sessionStorage)에 보관한다. */
  var TIMELY = {
    chatUrl: "https://timelyai.io/reborn-steel",
    spaceRefId: "reborn-steel",                                           // timelyGPT 관리자 페이지에서 만든 스페이스 주소
    authUrl: "https://ai.timelygpt.co.kr/api-back",
    sdk: "https://cdn.jsdelivr.net/gh/timely-hub/timely-chat@p.1.1.3/index.js"
  };

  /* ---------- 사람 ---------- */
  // 신입사원(접속자)의 자리. 이름만 입력받고 나머지는 과제 직무로 고정.
  var JOB = { team: "제강팀", dept: "생산본부", title: "사원", role: "스크랩 배합 담당",
    roleLong: "스크랩 배합 담당 (AI 배합 에이전트 운영)",
    duties: ["매일 아침 배합 에이전트가 쓴 지시서 초안 검토", "제강팀장에게 배합 지시서 결재 상신",
             "위험 로트·재고 부족 알림을 보고 배합에 반영됐는지 확인", "에이전트 실행 기록(반복 횟수, 판정 방식) 점검"] };
  var PEOPLE = [
    { id: "sa", name: "한지수", title: "대리", team: "제강팀", role: "배합 담당 · 내 사수" },
    { id: "jt", name: "박준영", title: "팀장", team: "제강팀", role: "제강팀장 · 1차 결재" },
    { id: "pd", name: "정민재", title: "본부장", team: "생산본부", role: "생산본부장 · 최종 결재" },
    { id: "qa", name: "이서연", title: "과장", team: "품질보증팀", role: "검수 메모 판정 확인" },
    { id: "yd", name: "윤가람", title: "주임", team: "원료팀", role: "스크랩 야드 검수" },
    { id: "pu", name: "최도윤", title: "대리", team: "구매팀", role: "스크랩 구매·재고" },
    { id: "ai", name: "강예린", title: "선임", team: "생산기술팀", role: "배합 에이전트 개발·운영" }
  ];
  var PBY = {}; PEOPLE.forEach(function (p) { PBY[p.id] = p; });
  var SYS = {
    agent: { name: "배합 에이전트", sub: "생산기술팀 · 자동 발송", mark: "AI" },
    stock: { name: "재고관리 시스템", sub: "원료팀 · 자동 발송", mark: "재" },
    price: { name: "시세 알림", sub: "구매팀 · 자동 발송", mark: "₩" },
    hr: { name: "인사팀", sub: "경영지원본부", mark: "인" },
    admin: { name: "경영지원팀", sub: "전사 공지", mark: "경" },
    safety: { name: "안전환경팀", sub: "전사 공지", mark: "안" },
    pr: { name: "홍보팀", sub: "전사 공지", mark: "홍" }
  };

  /* ---------- 작은 도구 ---------- */
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function won(v) { return Math.round(v).toLocaleString("ko-KR"); }
  function md(d) { return (+d.slice(5, 7)) + "/" + (+d.slice(8, 10)); }
  function dow(d) { return "일월화수목금토".charAt(new Date(d + "T00:00:00").getDay()); }
  function css(v) { return "var(" + v + ")"; }
  var mem = {};                 // localStorage를 못 쓸 때 이번 방문 동안만 기억
  var store = {
    get: function (k, def) { try { var v = localStorage.getItem(k); return v == null ? (k in mem ? mem[k] : def) : JSON.parse(v); } catch (e) { return k in mem ? mem[k] : def; } },
    set: function (k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 환경 */ } }
  };
  var params = new URLSearchParams(location.search);

  var DATES = D ? Object.keys(D.sheets).sort() : [];
  var MDATES = C ? Object.keys(C.market).sort() : [];
  var JOIN_DATE = DATES[0];     // 입사일 = 배합 에이전트 정식 적용일

  function cleanName(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX); }
  function me() {
    var n = state.name || "신입";
    return { id: "me", name: n, title: JOB.title, team: JOB.team, role: JOB.role, roleLong: JOB.roleLong, duties: JOB.duties };
  }
  function person(id) { return id === "me" ? me() : PBY[id]; }
  function sender(id) {
    var p = person(id);
    if (p) return { name: p.name + " " + p.title, sub: p.team + " · " + p.role, mark: p.name.charAt(0) };
    return SYS[id];
  }
  function dayNo(d) { return DATES.indexOf(d) + 1; }

  function prevMarketDate(d) { var i = MDATES.indexOf(d); return i > 0 ? MDATES[i - 1] : null; }
  function marketRow(d) { return (C.market[d]) || {}; }
  var AVG_INV = {};
  if (C) GRADES.forEach(function (g) {
    var s = 0; MDATES.forEach(function (d) { s += C.market[d][g][1]; }); AVG_INV[g] = s / MDATES.length;
  });
  function usage(sheet) {
    var u = {}; GRADES.forEach(function (g) { u[g] = 0; });
    sheet.heats.forEach(function (h) { h.charges.forEach(function (c) { u[c.grade_id] += c.t; }); });
    return u;
  }
  function tapTotal(sheet) { return sheet.heats.reduce(function (a, h) { return a + h.target_tap_t; }, 0); }
  function flagged(sheet) { return sheet.flags.filter(function (f) { return f.risk !== "none"; }); }
  function noteMethod() { return D.meta.use_llm ? "LLM(Claude)" : "키워드 규칙"; }
  function noteText(S, lot) { var n = S.notes.filter(function (x) { return x.lot_id === lot; })[0]; return n ? n.note_text : ""; }
  // 파이썬 실행 기록 문장을 읽기 쉽게: {'SD400': 14.7, ...} → SD400 14.7% · ..., ['LS_A'] → 경량A
  function prettyLog(s) {
    return String(s).replace("(keyword)", "(키워드 규칙)").replace("(llm)", "(LLM)").replace("강종별 최대 이탈확률(%)", "강종별 최대 이탈확률")
      .replace(/\{([^}]*)\}/g, function (m, inner) {
        return inner.split(/,\s*/).map(function (kv) { var p = kv.split(":"); return p[0].replace(/'/g, "").trim() + " " + (p[1] || "").trim() + "%"; }).join(" · ");
      })
      .replace(/\[([^\]]*)\]/g, function (m, inner) {
        var xs = inner.replace(/'/g, "").split(/,\s*/).filter(Boolean); return xs.length ? xs.map(function (g) { return GNAME[g] || g; }).join(", ") : "없음";
      });
  }

  /* ---------- 결재 상신·실행 기록 (이 브라우저에만 저장) ---------- */
  function getSubmit(d) { return store.get("rb-submit", {})[d] || null; }
  function setSubmit(d, v) {
    var s = store.get("rb-submit", {}); s[d] = v; store.set("rb-submit", s);
    var id = d + "|approved", r = store.get("rb-read", {}), k = store.get("rb-done", {});   // 다시 올리면 팀장 회신을 새 메일로
    delete r[id]; delete k[id]; store.set("rb-read", r); store.set("rb-done", k);
  }
  function getRuns(d) { return store.get("rb-runs", {})[d] || []; }
  function addRun(d, r) { var s = store.get("rb-runs", {}); var a = s[d] || []; r.no = a.length ? a[a.length - 1].no + 1 : 1; a.push(r); s[d] = a.slice(-12); store.set("rb-runs", s); return r; }
  function hasOverrides(ov) { return !!ov && Object.keys(ov.price || {}).length + Object.keys(ov.inv || {}).length > 0; }

  /* ---------- 날짜별 미션 ----------
     검수 메모 원문만 보고 정한다 (숨은 정답은 쓰지 않는다).
     키워드 규칙이 위험으로 본 메모 중 '제거 완료·이상 없음·정상'처럼 이미 해소됐다고 적힌 것은 '잘못 제외' 미션이 된다. */
  var RESOLVED = /제거 완료|이상 없음|정상 범위|분석 결과 정상/;
  function missionFor(d) {
    var S = D.sheets[d]; if (!S) return null;
    var fl = flagged(S), mk = marketRow(d);
    var decoy = fl.filter(function (f) { return RESOLVED.test(noteText(S, f.lot_id)); })[0];
    var risk = fl.filter(function (f) { return !RESOLVED.test(noteText(S, f.lot_id)); })[0];
    var short = GRADES.filter(function (g) { return mk[g][1] < SHORT_T; })[0];
    if (d === JOIN_DATE) return { type: "first", pic: "rebo-hello.jpg", title: "첫 배합 결재 올리기",
      story: "입사 첫날이에요. 배합 에이전트가 오늘 24 heat의 배합을 어떻게 정하는지 직접 실행해 보고, 결과를 확인해 결재까지 올려 봐요.",
      goals: ["에이전트 실행 버튼을 눌러 계산 과정을 지켜보기", "숙련자 배합보다 얼마나 싼지, 이탈 확률이 2% 이하인지 확인", "제강팀장에게 결재 상신"] };
    if (decoy) return { type: "decoy", lot: decoy.lot_id, grade: decoy.grade_id, pic: "rebo-recycle.jpg", title: "잘못 제외된 로트 찾기",
      story: "키워드 규칙이 " + GNAME[decoy.grade_id] + " 로트(" + decoy.lot_id + ")를 위험하다고 보고 배합에서 뺐어요. 그런데 메모를 끝까지 읽어 보면 어떨까요? “" + noteText(S, decoy.lot_id) + "”",
      goals: ["검수 메모 원문을 끝까지 읽고 판정이 맞는지 판단", "판정을 바로잡아 다시 실행하고, 원가가 얼마나 내려가는지 확인", "이탈 확률 목표를 지킨 배합으로 결재 상신"] };
    if (risk) return { type: "risk", lot: risk.lot_id, grade: risk.grade_id, pic: "rebo-safety.jpg", title: GNAME[risk.grade_id] + " 위험 로트 막기",
      story: "오늘 들어온 " + GNAME[risk.grade_id] + " 로트에 이런 메모가 있어요. “" + noteText(S, risk.lot_id) + "” Cu·Sn은 전기로에서 빠지지 않아요. 배합에서 막아야 해요.",
      goals: ["(실험) 판정을 '영향 없음'으로 바꿔 실행하면 원가가 얼마나 싸지는지 보기", "그래도 위험 로트는 제외하거나 5% 이하로 제한", "이탈 확률 목표를 지킨 배합으로 결재 상신"] };
    if (short) return { type: "shortage", grade: short, pic: "rebo-build.jpg", title: GNAME[short] + " 재고 부족 대응",
      story: GNAME[short] + " 재고가 " + mk[short][1] + "t뿐이에요(평소 약 " + Math.round(AVG_INV[short]) + "t). 에이전트는 재고 한도 안에서 배합을 다시 짜요. 긴급 발주를 하면 얼마나 아낄 수 있을까요?",
      goals: ["(가정해 보기) " + GNAME[short] + " 재고를 300t 이상으로 바꿔 실행하고 원가 차이 확인", "가정을 원래대로 되돌리고 실제 재고로 실행", "결재 상신 (검토 의견에 긴급 발주 효과를 적어 보세요)"] };
    return { type: "daily", pic: "rebo-hello.jpg", title: "오늘의 배합 결재",
      story: "특별한 사건이 없는 날이에요. 매일 하는 순서대로 실행 → 확인 → 결재를 해 봐요. 목표 이탈 확률을 바꿔 보면 원가가 어떻게 달라지는지도 살펴보세요.",
      goals: ["에이전트 실행", "이탈 확률과 원가 확인", "결재 상신"] };
  }
  // 결재한 내용으로 미션 성공 여부 판정
  function checkMission(d, sub) {
    var m = missionFor(d); if (!m || !sub) return null;
    var runs = getRuns(d), draft = D.sheets[d].summary.cost_per_t;
    if (!sub.pass) return { ok: false, msg: "이탈 확률이 목표를 넘는 배합으로 결재했어요. 판정이나 목표를 다시 확인해 보세요." };
    if (m.type === "risk") {
      var r = sub.risk[m.lot];
      var tried = runs.filter(function (x) { return x.risk && x.risk[m.lot] === "none"; })[0];
      if (r === "none") return { ok: false, msg: "위험 로트(" + m.lot + ")를 그대로 썼어요. 메모대로라면 Cu·Sn이 평소의 2배일 수 있어요. 에이전트는 메모를 모르면 위험을 계산하지 못해요." };
      return { ok: true, msg: "위험 로트를 " + (r === "high" ? "제외" : "5% 이하로 제한") + "하고 결재했어요." +
        (tried ? " 판정을 무시했다면 톤당 " + won(sub.costPerT - tried.costPerT) + "원 더 쌌지만, 그 차이는 이탈 위험의 대가예요." : "") };
    }
    if (m.type === "decoy") {
      if (sub.risk[m.lot] !== "none") return { ok: false, msg: "메모를 끝까지 읽어 보세요. 이미 해소됐다고 적혀 있다면 이 로트는 써도 돼요." };
      if (sub.costPerT >= draft) return { ok: false, msg: "판정은 바로잡았지만 원가가 자동 초안(" + won(draft) + "원)보다 낮아지지 않았어요." };
      return { ok: true, msg: "판정을 바로잡아 자동 초안보다 톤당 " + won(draft - sub.costPerT) + "원 아꼈어요. 키워드 규칙이 못 읽는 문맥을 사람이 읽은 거예요." };
    }
    if (m.type === "shortage") {
      var w = runs.filter(function (x) { return x.overrides && x.overrides.inv && x.overrides.inv[m.grade] >= 300; })[0];
      if (!w) return { ok: false, msg: "재고를 300t 이상으로 가정해 실행한 기록이 없어요. 긴급 발주 효과를 먼저 확인해 보세요." };
      return { ok: true, msg: "긴급 발주로 " + GNAME[m.grade] + "을 300t 이상 확보하면 톤당 약 " + won(sub.costPerT - w.costPerT) + "원(하루 약 " + ((sub.costPerT - w.costPerT) * 2400 / 1e4).toFixed(0) + "만 원) 아낄 수 있다는 걸 확인했어요." };
    }
    return { ok: true, msg: "목표 이탈 확률 안에서 숙련자 배합보다 톤당 " + won(sub.saving) + "원 싼 배합으로 결재했어요." };
  }

  /* ---------- timelyGPT 연결 (리보 AI 채팅) ---------- */
  function providerId() { var p = store.get("rb-pid", null); if (!p) { p = "reborn-" + Math.random().toString(36).slice(2, 10); store.set("rb-pid", p); } return p; }
  function timelyToken() {
    try { var t = JSON.parse(sessionStorage.getItem("rb-timely") || "null"); return t && t.exp > Date.now() ? t.token : null; } catch (e) { return mem["rb-timely"] && mem["rb-timely"].exp > Date.now() ? mem["rb-timely"].token : null; }
  }
  function timelyReady() { return !!TIMELY.spaceRefId; }
  function timelyConnect(apiKey) {
    if (!TIMELY.spaceRefId) return Promise.reject(new Error("스페이스 ID(spaceRefId)가 아직 설정되지 않았어요. assets/portal.js의 TIMELY 설정을 확인하세요."));
    return fetch(TIMELY.authUrl + "/user/auth/login", {
      method: "POST", headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ name: state.name || "신입", providerId: providerId(), spaceRefId: TIMELY.spaceRefId })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok || !j.success || !j.data) {
        // 서버 메시지를 그대로 보여 준다. 예: "해당하는 조직을 찾을 수 없습니다" → API 키 문제
        var why = j.message ? " 서버 응답: " + j.message : "";
        throw new Error("로그인에 실패했어요 (" + r.status + ")." + why + " API 키와 스페이스 ID(" + TIMELY.spaceRefId + ")를 확인하세요.");
      }
      var v = { token: j.data, exp: Date.now() + 23 * 3600 * 1000 };       // 토큰은 24시간 유효, 여유 1시간
      mem["rb-timely"] = v; try { sessionStorage.setItem("rb-timely", JSON.stringify(v)); } catch (e) { /* 창 메모리만 사용 */ }
      return true;
    }); });
  }
  function timelyDisconnect() { delete mem["rb-timely"]; try { sessionStorage.removeItem("rb-timely"); } catch (e) { /* 무시 */ } }
  var chatInst = null, sdkLoading = null;
  function loadSdk() {
    if (window.TimelyChat) return Promise.resolve();
    if (sdkLoading) return sdkLoading;
    sdkLoading = new Promise(function (ok, fail) {
      var s = document.createElement("script"); s.src = TIMELY.sdk; s.onload = ok;
      s.onerror = function () { sdkLoading = null; fail(new Error("채팅 모듈을 불러오지 못했어요.")); }; document.head.appendChild(s);
    });
    return sdkLoading;
  }
  // instructions: 지금 화면의 배합 결과를 요약한 글. 리보 AI가 이것을 바탕으로 답한다.
  function openReboChat(room, instructions, faq) {
    var token = timelyToken();
    if (!token) return Promise.reject(new Error("리보 AI가 연결되어 있지 않아요."));
    return loadSdk().then(function () {
      var icon = new URL(PROFILE_IMG, location.href).href;
      if (!chatInst) chatInst = new window.TimelyChat(document.body, { token: token, name: "리보 AI · 리본스틸", icons: { avatar: icon, chatbot: icon },
        chatbot: { faq: faq || [], instructions: instructions } });
      chatInst.send("chat-open", { chat: [{ refId: "reborn-blend", name: "배합 에이전트 작업실" }, room], instructions: instructions });
      chatInst.send("module-toggle", { type: "open" });
    });
  }

  /* ---------- 전사 공지 (가상) ---------- */
  var NOTICES = [
    { date: "2026-09-22", from: "admin", time: "08:30", key: "n-agent", subject: "[전사 공지] AI 배합 에이전트 정식 적용 안내",
      body: [{ p: "오늘부터 스크랩 배합 지시서 초안은 배합 에이전트가 씁니다. 결재선(배합 담당 → 제강팀장 → 생산본부장)은 그대로고, 최종 판단은 지금처럼 사람이 합니다." },
             { p: "에이전트는 검수 메모, 시세·재고, 과거 조업 이력을 보고 가장 싼 배합을 계산합니다. 그다음 모의 조업으로 heat별 규격 이탈 확률이 2%를 넘지 않는지 확인해요." },
             { p: "궁금한 점은 생산기술팀 강예린 선임에게 물어봐 주세요." }] },
    { date: "2026-09-22", from: "pr", time: "09:00", key: "n-rebo", subject: "[사내 캐릭터] 리보를 소개합니다",
      body: [{ img: "assets/rebo.png", alt: "리본스틸 공식 캐릭터 리보: 새싹이 돋은 흰 안전모와 녹색 작업복을 입은 너구리" },
             { p: "“버려진 철에 새로운 생명을 불어넣는 착한 지구 지킴이!” 리본스틸 공식 홍보대사 리보예요. 오늘부터 사내포털과 메일함의 기본 프로필 사진으로 쓰여요." },
             { kv: [["이름", "리보 (REBO)"], ["성격", "밝고 명랑하며, 환경을 생각하는 책임감 있는 친구"], ["특기", "버려진 고철의 새로운 가치 찾기"],
                    ["꿈", "자원이 순환하는 깨끗하고 튼튼한 세상 만들기"], ["역할", "ReBorn Steel의 공식 홍보대사"]] }] },
    { date: "2026-09-28", from: "safety", time: "08:40", key: "n-safety", subject: "[안전] 10월 전기로 작업자 안전보건 교육 일정",
      body: [{ img: BRAND + "rebo-safety.jpg", alt: "무전기를 들고 안전조끼를 입은 리보", small: true },
             { p: "안전이 먼저예요! 10월 정기 안전보건 교육 일정입니다. 교대조별로 한 번씩 참석해 주세요. 신입사원은 꼭 들어야 해요." },
             { kv: [["대상", "제강팀, 원료팀, 생산기술팀 현장 근무자"], ["일정", "10/6(화) ~ 10/8(목) 14:00~16:00"], ["장소", "본관 2층 교육장"], ["내용", "용강 비산·아크 화상 예방, 크레인 신호수 교육"]] }] },
    { date: "2026-10-05", from: "admin", time: "09:10", key: "n-vendor", subject: "[공지] 4분기 스크랩 협력사 평가 일정",
      body: [{ p: "4분기 협력사 평가에는 검수 메모의 위험 판정 이력과 성분 이상 로트 건수가 들어갑니다." },
             { kv: [["평가 기간", "10/12 ~ 10/23"], ["담당", "구매팀, 품질보증팀"]] }] },
    { date: "2026-10-16", from: "admin", time: "10:00", key: "n-lf", subject: "[설비] 10/18(일) 야간 LF 정기 점검",
      body: [{ p: "10/18(일) 22시부터 10/19(월) 6시까지 LF 래들 정련로를 정기 점검합니다. 하루 24 heat 계획에 차질이 없도록 점검 전후로 일정을 조정할 예정이에요." }] },
    { date: "2026-10-26", from: "admin", time: "08:30", key: "n-report", subject: "[전사 공지] 10월 원가 절감 실적 보고회 (10/30)",
      body: [{ img: BRAND + "rebo-build.jpg", alt: "철근 다발을 든 리보", small: true },
             { p: "10/30(금) 15시, 대회의실에서 10월 원가 절감 실적 보고회가 열립니다. 생산본부는 AI 배합을 적용한 효과를 발표해요." }] }
  ];

  /* ---------- 메일 만들기: 신입 배합 담당이 받는 메일 ---------- */
  function mailsOn(d) {
    var S = D.sheets[d]; if (!S) return [];
    var f = S.summary, out = [], u = me();
    function add(m) { m.date = d; m.id = d + "|" + m.key; out.push(m); }
    var fl = flagged(S);
    var maxH = S.heats.reduce(function (a, h) { return h.p_fail_pct > a.p_fail_pct ? h : a; }, S.heats[0]);
    var excl = fl.filter(function (x) { return x.risk === "high"; }).map(function (x) { return GNAME[x.grade_id]; });
    var capd = fl.filter(function (x) { return x.risk === "medium"; }).map(function (x) { return GNAME[x.grade_id]; });
    var daySave = f.saving_per_t * tapTotal(S);
    var mk = marketRow(d), pm = marketRow(prevMarketDate(d) || d), use = usage(S);

    // 입사 첫날
    if (d === JOIN_DATE) {
      add({ key: "welcome", from: "hr", to: ["me"], time: "08:00", tag: "공지",
        subject: "[입사 환영] " + u.name + " 사원님, 리본스틸에 오신 것을 환영합니다",
        body: [{ img: BRAND + "rebo-hello.jpg", alt: "손을 들어 인사하는 리보", small: true },
               { p: u.name + " 사원님, 입사를 진심으로 환영합니다. 리본스틸은 버려진 철스크랩을 녹여 철근으로 다시 태어나게 하는 전기로 제강사예요." },
               { kv: [["소속", JOB.dept + " " + JOB.team], ["직무", JOB.roleLong], ["직급", "사원 (신입)"], ["입사일", JOIN_DATE], ["사수", "한지수 대리 (제강팀 배합 담당)"]] },
               { p: "먼저 사내포털의 '회사·공지·조직' 메뉴에서 회사 소개와 공정, 조직도를 둘러보세요." }],
        tasks: { me: { text: "회사 소개·공정·조직도 둘러보기", href: "company.html" } } });
      add({ key: "handover", from: "sa", to: ["me"], time: "08:30", tag: "확인",
        subject: "[인수인계] 배합 업무 하루 흐름 안내",
        body: [{ p: u.name + "님, 사수 한지수입니다. 우리 일은 매일 24 heat의 스크랩 배합을 정하는 거예요. 계산은 배합 에이전트가 하지만, 결과를 확인하고 책임지고 결재를 올리는 건 우리 몫이에요." },
               { list: ["06:00~06:20 재고 부족·위험 로트 알림이 오면 먼저 읽어 두기",
                        "06:40 에이전트의 자동 초안 도착 → '지난 기록·미션'에서 직접 다시 실행해 보며 확인",
                        "검수 메모 판정이 이상하면 판정을 고치고 다시 실행 (자동 초안은 메모를 키워드로만 읽어요)",
                        "예측 이탈 확률(heat별 2% 이하)과 원가를 확인하고 박준영 팀장님께 결재 상신",
                        "Cu·Sn은 전기로·LF에서 빠지지 않으니, 배합에서 못 막으면 끝이에요!"] },
               { p: "모르는 건 언제든 메신저로 물어보세요." }],
        tasks: { me: { text: "인수인계 메일 읽고 하루 업무 흐름 익히기", href: "ops.html?date=" + d } } });
    }

    // 재고 부족
    GRADES.forEach(function (g) {
      var inv = mk[g] ? mk[g][1] : null;
      if (inv == null || inv >= SHORT_T) return;
      add({ key: "stock-" + g, from: "stock", to: ["me", "pu"], time: "06:00", tag: "확인",
        subject: "[재고 부족] " + GNAME[g] + " " + inv + "t",
        body: [{ kv: [["현재 재고", inv + "t (기준 " + SHORT_T + "t 미만)"], ["평소 재고", "약 " + Math.round(AVG_INV[g]) + "t"],
                      ["오늘 배합 사용량", use[g].toFixed(1) + "t"]] },
               { p: "배합 에이전트는 재고 한도 안에서만 배합을 짭니다. 긴급 발주는 구매팀 최도윤 대리가 검토해요." }],
        tasks: { me: { text: GNAME[g] + " 재고 " + inv + "t: 오늘 지시서의 사용량이 재고 안인지 확인", href: "yard.html?date=" + d + "&grade=" + g } } });
    });

    // 위험 로트
    fl.forEach(function (x) {
      var act = x.risk === "high" ? "배합 제외" : "장입 5% 제한";
      var body = [{ quote: S.notes.filter(function (n) { return n.lot_id === x.lot_id; }).map(function (n) { return n.note_text; })[0] || "" },
                  { kv: [["로트", x.lot_id], ["등급", GNAME[x.grade_id] + " (" + x.grade_id + ")"],
                         ["의심 원소", x.element === "cu" ? "Cu (구리)" : x.element === "sn" ? "Sn (주석)" : "-"],
                         ["추정 배수", "평소의 " + x.suspected_multiplier + "배"], ["조치", act], ["판정 방식", noteMethod()]] }];
      if (!D.meta.use_llm) body.push({ warn: "키워드 규칙은 문맥을 못 읽어요. '제거 완료', '분석 결과 정상'처럼 이미 해결된 메모도 위험으로 볼 수 있으니, 원문이 이상하면 품질보증팀 이서연 과장에게 확인해 주세요." });
      add({ key: "lot-" + x.lot_id, from: "agent", to: ["me", "qa"], time: "06:20", tag: "확인",
        subject: "[위험 로트] " + x.lot_id + " " + act, body: body,
        tasks: { me: { text: "로트 " + x.lot_id + "의 메모 원문 읽고 '" + act + "'가 맞는지 판단", href: "history.html?date=" + d + "#notes" } } });
    });

    // 지시서 초안
    add({ key: "draft", from: "agent", to: ["me"], time: "06:40", tag: "결재",
      subject: "[배합 지시서 초안] " + md(d) + " 24 heat · 톤당 " + won(f.cost_per_t) + "원",
      body: [{ p: "오늘 24 heat 배합 지시서 자동 초안이 나왔어요. '지난 기록·미션'에서 검토하고, 필요하면 판정을 고쳐 다시 돌린 뒤 결재를 올려 주세요." },
             { kv: [["톤당 배합 원가", won(f.cost_per_t) + "원 (숙련자 배합 " + won(f.expert_cost_per_t) + "원)"],
                    ["톤당 절감", won(f.saving_per_t) + "원 · 하루 약 " + (daySave / 1e6).toFixed(1) + "백만 원"],
                    ["최적화–모의 조업", f.iterations + "회 반복"],
                    ["예측 최대 이탈 확률", maxH.p_fail_pct.toFixed(1) + "% (" + maxH.heat_id + ", " + maxH.steel_grade + ")"],
                    ["배합 제외 등급", excl.length ? excl.join(", ") : "없음"],
                    ["5% 제한 등급", capd.length ? capd.join(", ") : "없음"]] },
             { p: S.rationale.day_summary }],
      tasks: { me: { text: "배합 지시서 검토·실행 후 제강팀장에게 결재 상신", href: "history.html?date=" + d } } });

    // 실행 기록
    var runBody = [{ kv: [["반복 횟수", f.iterations + "회 (최대 6회)"], ["검수 메모 판정", noteMethod()], ["지시서 근거 작성", S.rationale.method === "llm" ? "LLM(Claude)" : "고정 템플릿"]] },
                   { list: S.log.map(prettyLog) }];
    if (!D.meta.use_llm) runBody.push({ warn: "API 키 없이 돌려서, 검수 메모는 키워드 규칙으로, 근거 문장은 템플릿으로 처리했어요." });
    add({ key: "runlog", from: "agent", to: ["me", "ai"], time: "07:00", tag: f.iterations >= 4 ? "확인" : "참고",
      subject: "[실행 기록] " + md(d) + " 반복 " + f.iterations + "회 · 판정 " + noteMethod(), body: runBody,
      tasks: { me: { text: "실행 기록 점검: 반복 " + f.iterations + "회" + (f.iterations >= 4 ? " (평소보다 많음, 원인 확인)" : ""), href: "ops.html?date=" + d + "#log" } } });

    // 목표에 가까운 heat
    if (maxH.p_fail_pct >= 1.5) add({ key: "heat-" + maxH.heat_id, from: "agent", to: ["me", "jt"], time: "07:10", tag: "확인",
      subject: "[주의 heat] " + maxH.heat_id + " " + maxH.steel_grade + " 예측 이탈 " + maxH.p_fail_pct.toFixed(1) + "%",
      body: [{ p: "목표(2%) 안이긴 하지만 오늘 가장 높은 heat예요. 장입하고 나서 1차 성분 분석 결과를 바로 확인해 주세요." },
             { kv: [["예상 Cu", maxH.pred_cu_pct.toFixed(3) + "% (상한 " + maxH.cu_max_pct + "%)"], ["예상 Sn", maxH.pred_sn_pct.toFixed(4) + "% (상한 " + maxH.sn_max_pct + "%)"]] }],
      tasks: { me: { text: maxH.heat_id + " 장입 후 1차 성분 분석 결과 확인", href: "ops.html?date=" + d + "&heat=" + maxH.heat_id } } });

    // 시세 급변 (참고)
    var chg = GRADES.map(function (g) { var a = mk[g][0], b = pm[g][0]; return { g: g, p: a, c: (a - b) / b * 100 }; });
    var top = chg.slice().sort(function (a, b) { return Math.abs(b.c) - Math.abs(a.c); })[0];
    if (Math.abs(top.c) >= 0.5) add({ key: "price", from: "price", to: ["me", "pu"], time: "07:30", tag: "참고",
      subject: "[시세] " + GNAME[top.g] + " 전일 대비 " + (top.c >= 0 ? "+" : "") + top.c.toFixed(2) + "%",
      body: [{ p: "시세가 바뀌면 가장 싼 배합도 달라져요. 오늘 지시서에서 " + GNAME[top.g] + " 사용량이 어떻게 바뀌었는지 봐 두세요." },
             { table: { head: ["등급", "단가(원/t)", "전일 대비"], rows: chg.map(function (x) { return [GNAME[x.g], won(x.p), (x.c >= 0 ? "+" : "") + x.c.toFixed(2) + "%"]; }) } }] });

    // 결재 결과 (제강팀장): 지난 기록·미션에서 결재를 올렸을 때만 온다
    var sub = getSubmit(d);
    if (sub) {
      var mres = checkMission(d, sub);
      var memo = mres && mres.ok ? mres.msg + " 잘했어요." : mres ? "다만 " + mres.msg : "오늘도 수고 많았어요.";
      add({ key: "approved", from: "jt", to: ["me"], time: sub.time || "11:00", tag: mres && !mres.ok ? "확인" : "참고",
        subject: "[결재 " + (mres && !mres.ok ? "보완 요청" : "완료") + "] " + md(d) + " 배합 지시서",
        body: [{ p: u.name + " 씨, " + md(d) + " 배합 지시서 받았어요. 톤당 " + won(sub.costPerT) + "원으로 숙련자 배합보다 " + won(sub.saving) + "원 싸고, 예측 최대 이탈은 " + sub.maxP.toFixed(1) + "%네요." },
               { p: memo }].concat(sub.comment ? [{ quote: "검토 의견: " + sub.comment }] : [])
               .concat([{ p: mres && !mres.ok ? "다시 확인하고 올려 주세요." : "생산본부장님께 최종 결재로 넘겼어요." }]),
        tasks: mres && !mres.ok ? { me: { text: "팀장 보완 요청: 다시 검토 후 재상신", href: "history.html?date=" + d } } : null });
    }

    NOTICES.forEach(function (nt) { if (nt.date === d) add({ key: nt.key, from: nt.from, to: ["all"], time: nt.time, tag: "공지", subject: nt.subject, body: nt.body }); });
    return out;
  }

  function mailbox(d, days) {
    var i = DATES.indexOf(d), win = DATES.slice(Math.max(0, i - (days || 3) + 1), i + 1).reverse();
    var out = [];
    win.forEach(function (x) {
      mailsOn(x).sort(function (a, b) { return b.time < a.time ? -1 : 1; }).forEach(function (m) { out.push(m); });
    });
    return out;
  }
  function taskOf(m) { return m.tasks && m.tasks.me ? m.tasks.me : null; }
  function isRead(m) { return !!store.get("rb-read", {})[m.id]; }
  function setRead(m) { var r = store.get("rb-read", {}); r[m.id] = 1; store.set("rb-read", r); }
  function isDone(m) {
    if (m.key === "draft" && getSubmit(m.date)) return true;             // 결재를 올리면 지시서 할 일은 자동 완료
    if (m.key === "approved") { var s = getSubmit(m.date), r = s && checkMission(m.date, s); if (r && !r.ok) return false; }
    return !!store.get("rb-done", {})[m.id];
  }
  function setDone(m, v) { var r = store.get("rb-done", {}); if (v) r[m.id] = 1; else delete r[m.id]; store.set("rb-done", r); }

  /* ---------- 표시 부품 ---------- */
  function profilePic(cls) { return '<img class="avatar pic ' + (cls || "") + '" src="' + PROFILE_IMG + '" alt="">'; }
  function senderAvatar(id) {
    return person(id) ? profilePic() : '<span class="avatar sys" aria-hidden="true">' + esc(SYS[id].mark) + '</span>';
  }
  var TAGCLS = { "결재": "point", "조치": "warn", "확인": "info", "참고": "mute", "공지": "mute" };
  function tagPill(t) { return '<span class="pill ' + TAGCLS[t] + '">' + esc(t) + "</span>"; }
  function riskPill(r) {
    if (r === "high") return '<span class="pill crit">▲ 제외</span>';
    if (r === "medium") return '<span class="pill warn">△ 5% 제한</span>';
    return '<span class="pill mute">영향 없음</span>';
  }
  function renderBody(blocks) {
    return blocks.map(function (b) {
      if (b.p) return "<p>" + esc(b.p) + "</p>";
      if (b.quote != null) return "<blockquote>" + esc(b.quote) + "</blockquote>";
      if (b.warn) return '<p class="ink2" style="font-size:var(--fs-md)"><span class="pill warn">주의</span> ' + esc(b.warn) + "</p>";
      if (b.list) return '<ul style="margin:0;padding-left:18px">' + b.list.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
      if (b.kv) return '<dl class="kv">' + b.kv.map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>"; }).join("") + "</dl>";
      if (b.img) return '<img class="' + (b.small ? "mailpic" : "") + '" src="' + esc(b.img) + '" alt="' + esc(b.alt) + '" style="width:' + (b.small ? 120 : 160) + 'px;height:auto">';
      if (b.table) return '<div class="scroll-x"><table><thead><tr>' + b.table.head.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") +
        "</tr></thead><tbody>" + b.table.rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + esc(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>";
      return "";
    }).join("");
  }

  /* ---------- 툴팁 ---------- */
  function tipEl() { var t = $("tip"); if (!t) { t = document.createElement("div"); t.id = "tip"; t.hidden = true; document.body.appendChild(t); } return t; }
  function showTip(ev, html) {
    var tip = tipEl(); tip.innerHTML = html; tip.hidden = false;
    var x = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    var y = ev.clientY - tip.offsetHeight - 10; if (y < 8) y = ev.clientY + 16;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function hideTip() { tipEl().hidden = true; }
  function hover(el, html) { el.addEventListener("mousemove", function (e) { showTip(e, html); }); el.addEventListener("mouseleave", hideTip); }

  /* ---------- 선 그래프 (한 축, 시리즈 ≤ 2, 끝점 이름표) ---------- */
  var NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
    if (parent) parent.appendChild(e); return e;
  }
  function niceRange(lo, hi, n) {
    var span = hi - lo || Math.abs(hi) || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; }).filter(function (s) { return s >= raw; })[0];
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step: step };
  }
  function lineChart(svg, o) {
    // o: {x: [날짜], series: [{name, color, vals}], fmt, tipFmt, ref: {v, label}, W, H}
    svg.innerHTML = "";
    var W = o.W || 540, H = o.H || 220, x0 = 58, x1 = W - (o.series.length > 1 ? 92 : 20), y0 = H - 28, y1 = 14;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    var all = []; o.series.forEach(function (s) { all = all.concat(s.vals); }); if (o.ref) all.push(o.ref.v);
    var r = niceRange(Math.min.apply(null, all), Math.max.apply(null, all), 4);
    var n = o.x.length, X = function (i) { return n === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (n - 1); };
    var Y = function (v) { return y0 - (v - r.lo) / (r.hi - r.lo) * (y0 - y1); };
    for (var v = r.lo; v <= r.hi + r.step / 2; v += r.step) {
      svgEl("line", { x1: x0, x2: x1, y1: Y(v), y2: Y(v), style: "stroke:var(" + (v === r.lo ? "--axis" : "--grid") + ");stroke-width:1" }, svg);
      svgEl("text", { x: x0 - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 12, style: "fill:var(--muted)", text: o.fmt(v) }, svg);
    }
    if (o.ref) {
      svgEl("line", { x1: x0, x2: x1, y1: Y(o.ref.v), y2: Y(o.ref.v), style: "stroke:var(--ink-2);stroke-width:1;stroke-dasharray:4 3" }, svg);
      svgEl("text", { x: x0 + 4, y: Y(o.ref.v) - 5, "font-size": 11.5, style: "fill:var(--ink-2)", text: o.ref.label }, svg);
    }
    var ticks = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : [0];
    ticks.forEach(function (i, k) {
      svgEl("text", { x: X(i), y: y0 + 18, "text-anchor": ticks.length > 1 && k === 0 ? "start" : k === ticks.length - 1 && ticks.length > 1 ? "end" : "middle",
        "font-size": 12, style: "fill:var(--muted)", text: md(o.x[i]) }, svg);
    });
    o.series.forEach(function (s) {
      var pts = s.vals.map(function (v, i) { return X(i) + "," + Y(v); }).join(" ");
      if (n > 1) svgEl("polyline", { points: pts, style: "fill:none;stroke:" + s.color + ";stroke-width:2;stroke-linejoin:round;stroke-linecap:round" }, svg);
      var lx = X(n - 1), ly = Y(s.vals[n - 1]);
      svgEl("circle", { cx: lx, cy: ly, r: 4, style: "fill:" + s.color + ";stroke:var(--surface);stroke-width:2" }, svg);
      if (o.series.length > 1) svgEl("text", { x: lx + 8, y: ly + 4, "font-size": 12, style: "fill:var(--ink-2)", text: s.name }, svg);
    });
    var cross = svgEl("line", { x1: 0, x2: 0, y1: y1, y2: y0, style: "stroke:var(--ink-2);stroke-width:1;opacity:0" }, svg);
    var hit = svgEl("rect", { x: x0 - 6, y: y1, width: x1 - x0 + 12, height: y0 - y1, style: "fill:transparent" }, svg);
    hit.addEventListener("mousemove", function (e) {
      var b = svg.getBoundingClientRect(), sx = (e.clientX - b.left) / b.width * W;
      var i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((sx - x0) / (x1 - x0) * (n - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.style.opacity = 1;
      showTip(e, "<b>" + o.x[i] + " (" + dow(o.x[i]) + ")</b><br>" + o.series.map(function (s) { return esc(s.name) + " " + o.tipFmt(s.vals[i]); }).join("<br>"));
    });
    hit.addEventListener("mouseleave", function () { cross.style.opacity = 0; hideTip(); });
  }

  /* ---------- 상태: 이름, 기준일 ---------- */
  var state = {
    name: (function () { var n = cleanName(params.get("name") || store.get("rb-name", "")); return n || null; })(),
    date: (function () {
      var d = params.get("date") || store.get("rb-date", null);
      return DATES.indexOf(d) >= 0 ? d : JOIN_DATE;     // 처음이면 입사 첫날부터
    })()
  };
  if (state.name) store.set("rb-name", state.name);
  store.set("rb-date", state.date);
  var renderFn = null;

  var NAV = [["home", "index.html", "홈"], ["agent", "agent.html", "AI 배합 설계"], ["history", "history.html", "지난 기록·미션"], ["mail", "mail.html", "사내 메일함"],
             ["ops", "ops.html", "오늘의 조업 현황"], ["yard", "yard.html", "스크랩 야드·검수"], ["company", "company.html", "회사·공지·조직"], ["report", "report.html", "AI 도입 보고서"]];
  // 메뉴 아이콘 (24×24 선 그림, 색은 글자색을 따른다)
  var ICON = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    agent: '<path d="M9 3h6"/><path d="M10 3v6L4.5 18.5A1.6 1.6 0 0 0 5.9 21h12.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3"/><path d="M7.5 14h9"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    ops: '<path d="M3 21V10l5 3V10l5 3V6l8 4v11z"/><path d="M7 17h2M12 17h2M17 17h1"/>',
    yard: '<path d="M7 7h10l3 4-8 9-8-9z"/><path d="M4 11h16"/><path d="M12 20l-3-9 3-4 3 4z"/>',
    company: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/><path d="M10 21v-3h4v3"/>',
    report: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 17v-3M12 17v-6M15 17v-4"/>'
  };

  function buildShell() {
    var page = document.body.dataset.page;
    $("topbar").className = "topbar";
    $("topbar").innerHTML =
      '<a class="brand" href="index.html"><img src="' + BRAND + 'logo-mark.png" alt="" class="logo"><b>ReBorn Steel</b><em>사내포털</em></a>' +
      '<div class="ctx"><label for="dateSel"><span class="lbl">업무 기준일</span></label><select id="dateSel"></select></div>' +
      '<div class="me" id="me"></div>';
    var sel = $("dateSel");
    DATES.forEach(function (d) {
      var o = document.createElement("option"); o.value = d; o.textContent = d + " (" + dow(d) + ") · " + dayNo(d) + "일차"; sel.appendChild(o);
    });
    sel.addEventListener("change", function () { setDate(sel.value); });
    $("side").innerHTML = NAV.map(function (n) {
      return '<a href="' + n[1] + '"' + (n[0] === page ? ' aria-current="page"' : "") + '><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[n[0]] + "</svg><span>" + n[2] + "</span>" +
        (n[0] === "mail" ? '<span id="navBadge"></span>' : "") + "</a>";
    }).join("") + '<div class="sep"></div><p class="side-note">가상 기업 · 수업 과제<br>모든 데이터는 AI가 생성</p>';
    // 좁은 화면에서는 메뉴가 가로 탭이 되므로, 지금 페이지 탭이 보이게 스크롤한다
    var cur = $("side").querySelector('[aria-current="page"]');
    if (cur && window.matchMedia && window.matchMedia("(max-width: 900px)").matches) $("side").scrollLeft = Math.max(0, cur.offsetLeft - 16);
    if (!$("tip")) tipEl();
  }
  function updateShell() {
    $("dateSel").value = state.date;
    if (!state.name) { $("me").innerHTML = ""; $("navBadge").innerHTML = ""; return; }
    var p = me();
    $("me").innerHTML = profilePic() + '<div class="who-text"><b>' + esc(p.name) + " " + esc(p.title) +
      ' <span class="pill point">신입</span></b><br><span>' + esc(p.team) + " · " + esc(p.role) +
      '</span></div><button class="btn sm" type="button" id="renameBtn">이름 변경</button>';
    $("renameBtn").addEventListener("click", function () { openJoin(true); });
    var unread = mailbox(state.date).filter(function (m) { return !isRead(m); }).length;
    $("navBadge").innerHTML = unread ? '<span class="badge" aria-label="안 읽은 메일 ' + unread + '통">' + unread + "</span>" : "";
  }

  /* 입사 창: 이름 입력 → 직무 배정 안내 */
  function openJoin(rename) {
    var w = document.createElement("div"); w.className = "who"; w.setAttribute("role", "dialog"); w.setAttribute("aria-modal", "true"); w.setAttribute("aria-labelledby", "joinT");
    function close() { if (w.parentNode) document.body.removeChild(w); }
    function step1() {
      w.innerHTML = '<div class="panel join"><div class="join-brand"><img src="' + BRAND + 'logo-mark.png" alt=""><b>ReBorn Steel</b></div>' +
        '<div class="join-hero"><img src="' + BRAND + 'rebo-hello.jpg" alt="손을 들어 인사하는 리보"><div>' +
        '<h2 id="joinT">' + (rename ? "이름을 바꿀까요?" : "리본스틸에 오신 것을 환영합니다!") + "</h2>" +
        '<p class="ink2">' + (rename ? "새 이름을 입력하세요. 메일과 할 일 기록은 그대로 남아요." : "안녕하세요, 리본스틸 공식 홍보대사 리보예요. 오늘부터 함께 일할 신입사원님의 이름을 알려 주세요.") + "</p></div></div>" +
        '<form id="joinForm" class="join-form" novalidate><label for="joinName">이름을 입력하세요</label>' +
        '<div class="join-row"><input id="joinName" name="name" type="text" maxlength="' + NAME_MAX + '" autocomplete="name" placeholder="예: 김리본" value="' + esc(rename ? state.name : "") + '">' +
        '<button class="btn primary" type="submit">' + (rename ? "바꾸기" : "입사하기") + "</button></div>" +
        '<p class="join-err" id="joinErr" role="alert"></p></form>' +
        (rename ? '<div style="text-align:right"><button class="btn" type="button" id="joinCancel">취소</button></div>' : "") + "</div>";
      $("joinForm").addEventListener("submit", function (e) {
        e.preventDefault();
        var n = cleanName($("joinName").value);
        if (!n) { $("joinErr").textContent = "이름을 한 글자 이상 입력해 주세요."; $("joinName").focus(); return; }
        var first = !state.name;
        state.name = n; store.set("rb-name", n);
        if (!first) { close(); rerender(); return; }
        state.date = JOIN_DATE; store.set("rb-date", JOIN_DATE); syncUrl(); step2();
      });
      if (rename) $("joinCancel").addEventListener("click", close);
      $("joinName").focus();
    }
    function step2() {
      var p = me();
      w.innerHTML = '<div class="panel join"><div class="join-brand"><img src="' + BRAND + 'logo-mark.png" alt=""><b>ReBorn Steel</b></div>' +
        '<h2 id="joinT">' + esc(p.name) + " 사원님, 일할 자리가 정해졌어요!</h2>" +
        '<dl class="kv join-kv"><dt>소속</dt><dd>' + JOB.dept + " " + JOB.team + "</dd><dt>직무</dt><dd><b>" + JOB.roleLong + "</b></dd><dt>직급</dt><dd>사원 (신입)</dd>" +
        "<dt>입사일</dt><dd>" + JOIN_DATE + " (" + dow(JOIN_DATE) + ")</dd><dt>사수</dt><dd>한지수 대리</dd></dl>" +
        '<div class="join-job"><img src="' + BRAND + 'rebo-recycle.jpg" alt="재활용 마크 판을 든 리보"><div><b>무슨 일을 하나요?</b><ul>' +
        JOB.duties.map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("") + "</ul></div></div>" +
        '<p class="ink2" style="font-size:var(--fs-md)">첫날 할 일은 사내 메일함에 와 있어요. 조건을 넣고 AI에게 배합을 풀게 하는 건 <b>AI 배합 설계</b>, 날짜별 미션과 결재는 <b>지난 기록·미션</b>에서 해요. 위쪽의 업무 기준일을 바꾸면 다음 날로 넘어가요.</p>' +
        '<div style="text-align:right"><button class="btn primary" type="button" id="joinGo">사내포털 시작하기</button></div></div>';
      $("joinGo").addEventListener("click", function () { close(); rerender(); });
      $("joinGo").focus();
    }
    w.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.name) { close(); rerender(); } });
    document.body.appendChild(w);
    step1();
  }

  function syncUrl() {
    var u = new URL(location.href); u.searchParams.set("date", state.date); u.searchParams.delete("name");
    try { history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (e) { /* file:// 등 */ }
  }
  function setDate(d) { state.date = d; store.set("rb-date", d); syncUrl(); rerender(); }
  function rerender() { updateShell(); if (state.name && renderFn) renderFn(ctx()); }
  function ctx() { return { user: me(), date: state.date, sheet: D.sheets[state.date], day: dayNo(state.date) }; }

  function start(fn) {
    if (!D || !C) {
      document.body.innerHTML = '<p style="padding:16px">데이터를 불러오지 못했어요. <code>python src/evaluate.py</code>와 <code>python src/export_intranet.py</code>를 먼저 실행해 주세요.</p>';
      return;
    }
    renderFn = fn; buildShell(); rerender();
    if (!state.name) openJoin(false);
  }

  window.Portal = {
    D: D, C: C, GRADES: GRADES, GNAME: GNAME, GCOL: GCOL, PEOPLE: PEOPLE, JOB: JOB, NOTICES: NOTICES, DATES: DATES, MDATES: MDATES,
    SHORT_T: SHORT_T, AVG_INV: AVG_INV, JOIN_DATE: JOIN_DATE, BRAND: BRAND,
    $: $, esc: esc, won: won, md: md, dow: dow, css: css, store: store, params: params,
    me: me, person: person, mailsOn: mailsOn, mailbox: mailbox, taskOf: taskOf, isRead: isRead, setRead: setRead, isDone: isDone, setDone: setDone,
    sender: sender, senderAvatar: senderAvatar, profilePic: profilePic, tagPill: tagPill, riskPill: riskPill, renderBody: renderBody,
    flagged: flagged, usage: usage, tapTotal: tapTotal, noteMethod: noteMethod, marketRow: marketRow, prevMarketDate: prevMarketDate,
    hover: hover, showTip: showTip, hideTip: hideTip, svgEl: svgEl, lineChart: lineChart,
    start: start, refresh: function () { updateShell(); }, setDate: setDate,
    noteText: noteText, prettyLog: prettyLog, getSubmit: getSubmit, setSubmit: setSubmit, getRuns: getRuns, addRun: addRun, hasOverrides: hasOverrides,
    missionFor: missionFor, checkMission: checkMission, RESOLVED: RESOLVED,
    timely: { chatUrl: TIMELY.chatUrl, ready: timelyReady, token: timelyToken, connect: timelyConnect, disconnect: timelyDisconnect, open: openReboChat }
  };
})();
