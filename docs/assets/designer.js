/* AI 배합 설계 (agent.html)
   사용자가 조건(스크랩 등급·가격·재고·성분, 강종 상한·heat 수, 검수 메모)을 넣으면
   AI 에이전트(TimelyGPT를 거친 Claude·GPT, 또는 Claude 직접 연결)가 도구를 골라 쓰며 가장 싸고 규격을 지키는 배합을 직접 풀어 낸다.
   - 계산(선형계획, 모의 조업)은 engine.js가 이 브라우저에서 한다. AI는 숫자를 만들지 않는다.
   - AI가 하는 일: 조건 읽기, 검수 메모 해석(제외/5% 제한/영향 없음), 안전여유 결정과 재계산 판단, 결과 설명.
   - API 키는 사용자가 넣는다. 코드나 저장소에 넣지 않고, 원하면 이 창(sessionStorage)에만 둔다.
   - 키가 없으면 같은 계산을 키워드 규칙으로 돌린다("AI 없이 계산").
   - 실행 기록(과정·결과)은 이 브라우저에 최근 5건 저장해, 발표 모드에서 한 단계씩 다시 볼 수 있다. */
(function () {
  "use strict";
  var P = window.Portal, E = window.RebornEngine, A = window.RebornAnalysis;
  if (!P || !P.D || !E || !A) return;
  var $ = P.$, esc = P.esc, C = P.C, won = P.won;
  var PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6;           // 달러/토큰 (Claude Opus 5.5, 직접 연결일 때만 표시)
  var MAX_TURNS = 30, MAX_OPT = Math.max(8, C.config.max_iterations), N_SIM = C.config.n_sim;
  var LIMITS = { grades: 15, heats: 48 };
  var PALETTE = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
  var RUNS_KEY = "rb-design-runs";
  /* 검증 기준 = 목표 × 0.75 (목표 2%면 1.5%).
     정답 채점에서 AI가 추정 이탈 확률을 2% 바로 밑까지 맞추면, 추정 성분의 오차(경량A Cu를 낮게 봄) 때문에
     실제 이탈이 목표를 넘는 것을 확인했다. 그래서 모의 조업의 통과 판정에 여유를 둔다. */
  var SAFETY = 0.75;
  function gateOf(s) { return s.gate || s.target; }   // 예전에 저장한 실행은 gate가 없어서 목표 그대로

  /* ====================================================================
     1. 조건 (spec): 화면 입력과 1:1로 대응하는 상태
     ==================================================================== */
  var spec = null, specDate = null, dirty = false, curDate = null;   // curDate: 사내포털의 업무 기준일
  var nextId = 1;

  function specFromDate(d) {
    var mk = C.market[d], est = C.estimate.grades, byId = {};
    C.scrap.forEach(function (s) { byId[s.grade_id] = s; });
    var cnt = {}; C.plan.forEach(function (p) { cnt[p.steel_grade] = (cnt[p.steel_grade] || 0) + 1; });
    return {
      grades: C.config.grades.map(function (g) {
        return { id: g, name: byId[g].name_kr, price: mk[g][0], inv: mk[g][1], y: byId[g].yield, dens: byId[g].bulk_density_t_per_m3,
                 cu: r4(est[g].cu_mean), cuSd: r4(est[g].cu_sd), sn: r5(est[g].sn_mean), snSd: r5(est[g].sn_sd),
                 cuSe: r4(est[g].cu_se || 0), snSe: r5(est[g].sn_se || 0) };
      }),
      steels: C.specs.map(function (s) { return { steel: s.steel_grade, cu: s.cu_max_pct, sn: s.sn_max_pct, heats: cnt[s.steel_grade] || 0, W: 100 }; }),
      notes: C.notes.filter(function (n) { return n.date === d; }).map(function (n, i) { return { id: "N" + (i + 1), grade: n.grade_id, text: n.note_text }; }),
      target: 0.02, vol: C.config.max_charge_volume_m3, measSd: C.estimate.meas_sd, date: d
    };
  }
  function pct(p) { return String(+(p * 100).toFixed(2)); }   // 0.015 → "1.5"
  function r4(v) { return Math.round(v * 1e4) / 1e4; }
  function r5(v) { return Math.round(v * 1e5) / 1e5; }
  // 결과·과정 화면은 실행 당시 조건(run.spec)으로, 입력 화면은 지금 조건(spec)으로 이름·색을 찾는다
  function gradeName(id, s) { s = s || (run ? run.spec : spec); var g = s.grades.filter(function (x) { return x.id === id; })[0]; return g ? g.name : id; }
  function gradeColor(id, s) {
    s = s || (run ? run.spec : spec);
    if (P.GCOL[id]) return P.css(P.GCOL[id]);
    var i = s.grades.map(function (g) { return g.id; }).indexOf(id);
    return i >= 0 && i < PALETTE.length ? P.css(PALETTE[i]) : "var(--muted)";
  }

  // 입력값 검사: 계산 전에 사람이 고칠 수 있게 한 줄씩 알려 준다
  function validate(s) {
    var errs = [];
    if (s.grades.length < 2) errs.push("스크랩 등급은 2개 이상 있어야 해요.");
    if (s.grades.length > LIMITS.grades) errs.push("스크랩 등급은 " + LIMITS.grades + "개까지 넣을 수 있어요.");
    s.grades.forEach(function (g) {
      var nm = g.name || "(이름 없음)";
      if (!String(g.name).trim()) errs.push("이름이 빈 등급이 있어요.");
      if (!(g.price > 0)) errs.push(nm + ": 단가를 0보다 크게 넣어 주세요.");
      if (!(g.inv >= 0)) errs.push(nm + ": 재고는 0 이상이어야 해요.");
      if (!(g.y > 0 && g.y <= 1)) errs.push(nm + ": 실수율은 0과 1 사이여야 해요.");
      if (!(g.dens > 0)) errs.push(nm + ": 부피밀도를 0보다 크게 넣어 주세요.");
      if (!(g.cu >= 0 && g.sn >= 0 && g.cuSd >= 0 && g.snSd >= 0)) errs.push(nm + ": Cu·Sn 값은 0 이상이어야 해요.");
    });
    var names = {}, total = 0;
    if (!s.steels.length) errs.push("강종을 하나 이상 넣어 주세요.");
    s.steels.forEach(function (t) {
      var nm = String(t.steel).trim();
      if (!nm) errs.push("이름이 빈 강종이 있어요.");
      if (names[nm]) errs.push("강종 이름 '" + nm + "'이 겹쳐요.");
      names[nm] = 1;
      if (!(t.cu > 0 && t.sn > 0)) errs.push(nm + ": Cu·Sn 상한을 0보다 크게 넣어 주세요.");
      if (!(t.heats >= 0 && Math.floor(t.heats) === +t.heats)) errs.push(nm + ": heat 수는 0 이상의 정수여야 해요.");
      if (!(t.W > 0)) errs.push(nm + ": heat당 출강량을 0보다 크게 넣어 주세요.");
      total += +t.heats || 0;
    });
    if (total < 1) errs.push("생산할 heat가 하나도 없어요.");
    if (total > LIMITS.heats) errs.push("heat는 모두 합쳐 " + LIMITS.heats + "개까지 계산할 수 있어요.");
    if (!(s.vol > 0)) errs.push("버킷 용적을 0보다 크게 넣어 주세요.");
    return errs;
  }
  function engineSpec(s) {
    return { grades: s.grades, steels: s.steels.filter(function (t) { return t.heats > 0; }).map(function (t) { return { steel: String(t.steel).trim(), cu: +t.cu, sn: +t.sn, heats: +t.heats, W: +t.W }; }),
             vol: +s.vol, measSd: s.measSd };
  }

  /* ====================================================================
     2. 입력 화면 그리기
     ==================================================================== */
  function num(v, step) { return '<input type="number" step="' + step + '" min="0" value="' + esc(v) + '">'; }
  function drawGrades() {
    $("gradeRows").innerHTML = spec.grades.map(function (g, i) {
      return '<tr data-i="' + i + '"><td><span class="sw" style="background:' + gradeColor(g.id, spec) + '"></span><input type="text" data-k="name" value="' + esc(g.name) + '" aria-label="등급 이름" style="width:110px"> <span class="mono muted">' + esc(g.id) + "</span></td>" +
        '<td class="r">' + num(g.price, 1000).replace("<input", '<input data-k="price" aria-label="단가" style="width:104px"') + "</td>" +
        '<td class="r">' + num(g.inv, 10).replace("<input", '<input data-k="inv" aria-label="재고" style="width:80px"') + "</td>" +
        '<td class="r">' + num(g.y, 0.01).replace("<input", '<input data-k="y" aria-label="실수율" style="width:70px"') + "</td>" +
        '<td class="r">' + num(g.dens, 0.05).replace("<input", '<input data-k="dens" aria-label="부피밀도" style="width:70px"') + "</td>" +
        '<td class="r">' + num(g.cu, 0.001).replace("<input", '<input data-k="cu" aria-label="Cu 평균" style="width:86px"') + ' <span class="muted">±</span> ' +
          num(g.cuSd, 0.001).replace("<input", '<input data-k="cuSd" aria-label="Cu 편차" style="width:72px"') +
          (+g.cuSe > 0 ? '<div class="muted" style="font-size:11px" title="과거 이력으로 추정한 평균값 자체의 오차. 모의 조업에 함께 넣어요.">평균 추정오차 ±' + (+g.cuSe).toFixed(3) + "</div>" : "") + "</td>" +
        '<td class="r">' + num(g.sn, 0.0001).replace("<input", '<input data-k="sn" aria-label="Sn 평균" style="width:94px"') + ' <span class="muted">±</span> ' +
          num(g.snSd, 0.0001).replace("<input", '<input data-k="snSd" aria-label="Sn 편차" style="width:86px"') + "</td>" +
        '<td><button class="btn sm" type="button" data-del="' + i + '" aria-label="' + esc(g.name) + ' 삭제">삭제</button></td></tr>';
    }).join("");
    Array.prototype.forEach.call($("gradeRows").querySelectorAll("input"), function (inp) {
      inp.addEventListener("change", function () {
        var i = +inp.closest("tr").dataset.i, k = inp.dataset.k;
        spec.grades[i][k] = k === "name" ? inp.value.trim().slice(0, 20) : +inp.value;
        changed(k === "name");
      });
    });
    Array.prototype.forEach.call($("gradeRows").querySelectorAll("[data-del]"), function (b) {
      b.addEventListener("click", function () {
        var g = spec.grades[+b.dataset.del];
        spec.grades.splice(+b.dataset.del, 1);
        spec.notes = spec.notes.filter(function (n) { return n.grade !== g.id; });
        changed(true);
      });
    });
    $("gradeCount").textContent = spec.grades.length + "개 등급";
  }
  function drawSteels() {
    $("steelRows").innerHTML = spec.steels.map(function (t, i) {
      return '<tr data-i="' + i + '"><td><input type="text" data-k="steel" value="' + esc(t.steel) + '" aria-label="강종 이름" style="width:90px"></td>' +
        '<td class="r">' + num(t.cu, 0.01).replace("<input", '<input data-k="cu" aria-label="Cu 상한" style="width:76px"') + "</td>" +
        '<td class="r">' + num(t.sn, 0.001).replace("<input", '<input data-k="sn" aria-label="Sn 상한" style="width:80px"') + "</td>" +
        '<td class="r">' + num(t.heats, 1).replace("<input", '<input data-k="heats" aria-label="heat 수" style="width:64px"') + "</td>" +
        '<td class="r">' + num(t.W, 1).replace("<input", '<input data-k="W" aria-label="heat당 출강량" style="width:70px"') + "</td>" +
        '<td><button class="btn sm" type="button" data-del="' + i + '" aria-label="' + esc(t.steel) + ' 삭제">삭제</button></td></tr>';
    }).join("");
    Array.prototype.forEach.call($("steelRows").querySelectorAll("input"), function (inp) {
      inp.addEventListener("change", function () {
        var i = +inp.closest("tr").dataset.i, k = inp.dataset.k;
        spec.steels[i][k] = k === "steel" ? inp.value.trim().slice(0, 12) : +inp.value;
        changed(false);
      });
    });
    Array.prototype.forEach.call($("steelRows").querySelectorAll("[data-del]"), function (b) {
      b.addEventListener("click", function () { spec.steels.splice(+b.dataset.del, 1); changed(true); });
    });
    var total = spec.steels.reduce(function (a, t) { return a + (+t.heats || 0); }, 0);
    $("heatTotal").textContent = "하루 " + total + " heat";
  }
  function drawNotes() {
    var opts = spec.grades.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.name) + "</option>"; }).join("");
    $("noteRows").innerHTML = spec.notes.length ? spec.notes.map(function (n, i) {
      return '<li data-i="' + i + '"><select data-k="grade" aria-label="메모 등급">' + opts.replace('value="' + esc(n.grade) + '"', 'value="' + esc(n.grade) + '" selected') + "</select>" +
        '<input type="text" data-k="text" value="' + esc(n.text) + '" maxlength="120" aria-label="메모 내용" placeholder="예: 모터·전선 혼입 다수">' +
        '<button class="btn sm" type="button" data-del="' + i + '">삭제</button></li>';
    }).join("") : '<li class="empty">메모가 없어요. 검수 메모를 넣으면 AI가 읽고 판단해요.</li>';
    Array.prototype.forEach.call($("noteRows").querySelectorAll("select, input"), function (el) {
      el.addEventListener("change", function () { spec.notes[+el.closest("li").dataset.i][el.dataset.k] = el.dataset.k === "text" ? el.value.trim().slice(0, 120) : el.value; changed(false); });
    });
    Array.prototype.forEach.call($("noteRows").querySelectorAll("[data-del]"), function (b) {
      b.addEventListener("click", function () { spec.notes.splice(+b.dataset.del, 1); changed(true); });
    });
  }
  function drawSettings() { $("target").value = String(spec.target); $("vol").value = spec.vol; }
  function drawAll() { drawGrades(); drawSteels(); drawNotes(); drawSettings(); showErrors(); }
  function showErrors() {
    var errs = validate(spec);
    $("specErr").innerHTML = errs.length ? errs.slice(0, 5).map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + (errs.length > 5 ? "<li>외 " + (errs.length - 5) + "건</li>" : "") : "";
    $("specErr").hidden = !errs.length;
    $("aiBtn").disabled = $("plainBtn").disabled = !!errs.length || busy;
    return errs;
  }
  function changed(redraw) {
    dirty = true;
    $("loadNote").textContent = specDate ? specDate + " 조건을 불러와서 고친 상태예요." : "직접 입력한 조건이에요.";
    if (redraw) drawAll(); else showErrors();
  }

  /* ====================================================================
     3. 에이전트가 쓰는 도구 (브라우저에서 실제로 계산)
     ==================================================================== */
  var run = null;   // 지금 실행 중이거나 마지막으로 끝난 실행의 상태

  function newRun(mode) {
    var s = JSON.parse(JSON.stringify(spec));
    s.notes = s.notes.filter(function (n) { return String(n.text).trim(); });   // 빈 메모는 보내지 않는다
    s.gate = Math.round(s.target * SAFETY * 1e5) / 1e5;
    var su = E.customSetup(engineSpec(s));
    return { mode: mode, at: new Date().toISOString(), bizDate: curDate, spec: s, su: su, events: [], optCalls: 0,
             last: null, usage: { in: 0, out: 0, cacheR: 0, cacheW: 0 }, conclusion: "", status: "running",
             sens: [], topics: [], report: null };
  }
  function cfgFor() { return { grades: C.config.grades, expert_recipe: C.config.expert_recipe, substitutes: C.config.substitutes, max_iterations: MAX_OPT, n_sim: N_SIM }; }

  // 검수 메모 판정(note_rules) → 엔진 제약
  function rulesToNc(rules) {
    var flags = [];
    (rules || []).forEach(function (r) {
      var n = run.spec.notes.filter(function (x) { return x.id === r.note_id; })[0];
      if (!n) return;
      var risk = r.action === "exclude" ? "high" : r.action === "cap" ? "medium" : "none";
      var m = Math.min(Math.max(+r.multiplier || 1, 1), 4);
      if (risk !== "none" && m <= 1) m = 2;
      flags.push({ lot_id: n.id, grade_id: n.grade, element: risk === "none" ? "none" : (r.element === "sn" ? "sn" : "cu"), risk: risk, suspected_multiplier: m, reason: r.reason || "" });
    });
    return { flags: flags, nc: E.toConstraints(flags) };
  }
  function steelShares(opt, ctx, steel) {
    var sum = ctx.grades.map(function () { return 0; }), tot = 0;
    opt.heats.forEach(function (h) { if (h.steel === steel) h.x.forEach(function (v, i) { sum[i] += v; tot += v; }); });
    var out = {}; ctx.grades.forEach(function (g, i) { var p = tot ? sum[i] / tot * 100 : 0; if (p >= 0.05) out[gradeName(g)] = Math.round(p * 10) / 10; });
    return out;
  }

  var TOOLS_IMPL = {
    get_conditions: function () {
      var su = run.su, s = run.spec;
      return {
        grades: s.grades.map(function (g) { return { grade_id: g.id, name: g.name, price_krw_per_t: g.price, inventory_t: g.inv, yield: g.y, bulk_density_t_per_m3: g.dens,
          cu_mean_pct: g.cu, cu_sd_pct: g.cuSd, sn_mean_pct: g.sn, sn_sd_pct: g.snSd, cu_mean_se_pct: +g.cuSe || 0 }; }),
        steels: engineSpec(s).steels.map(function (t) { return { steel: t.steel, cu_max_pct: t.cu, sn_max_pct: t.sn, heats: t.heats, tap_t_per_heat: t.W }; }),
        bucket_volume_m3: s.vol, target_fail_prob: s.target, pass_criterion_p_fail: gateOf(s),
        pass_criterion_note: "모의 조업은 추정 성분으로 돌리기 때문에, 추정이 틀린 만큼 실제 이탈이 더 높을 수 있다. 그래서 통과 판정은 목표의 75%(pass_criterion_p_fail)로 한다. " +
          "cu_mean_se_pct는 Cu 평균 추정값 자체의 오차로, 모의 조업에 이미 들어가 있다.",
        notes: s.notes.map(function (n) { return { note_id: n.id, grade_id: n.grade, grade_name: gradeName(n.grade), text: n.text }; }),
        initial_margin_suggestion: E.initialMargins(su.ctx, su.comp, cfgFor(), gateOf(s)),
        max_optimize_calls: MAX_OPT
      };
    },
    optimize_blend: function (input) {
      if (run.optCalls >= MAX_OPT) return { error: "최적화는 " + MAX_OPT + "번까지만 할 수 있어요. 마지막 결과로 마무리하세요." };
      var su = run.su, conv = rulesToNc(input.note_rules), mg = {};
      Object.keys(su.ctx.specs).forEach(function (st) {        // 빠졌거나 음수인 여유는 0으로
        var m = (input.margins || {})[st] || {};
        mg[st] = { cu: Math.max(+m.cu || 0, 0), sn: Math.max(+m.sn || 0, 0) };
      });
      // 바로 앞과 똑같은 여유·판정으로 다시 부르면 같은 답이 나오므로 횟수를 쓰지 않고 돌려보낸다
      if (run.last && JSON.stringify(run.last.margins) === JSON.stringify(mg) && JSON.stringify(run.last.rules) === JSON.stringify(input.note_rules || []))
        return { status: "duplicate", iteration: run.optCalls, message: "바로 앞 계산과 안전여유·메모 판정이 같아서 다시 계산하지 않았어요. 지금 배합이 그대로 유효해요." };
      var o = E.optimize(su.ctx, su.comp, mg, conv.nc, window.solver);
      run.optCalls++;
      if (o.status !== "ok") return { status: "infeasible", iteration: run.optCalls, message: o.message,
        hint: "안전여유를 줄이거나, 제외한 등급을 다시 보거나, 재고·버킷 용적 조건을 확인하세요." };
      run.last = { opt: o, margins: mg, rules: input.note_rules || [], flags: conv.flags, nc: conv.nc, sim: null, seed: run.optCalls };
      var badReason = (input.note_rules || []).filter(function (r) { return !/[가-힣]/.test(String(r.reason || "")); }).map(function (r) { return r.note_id; });
      var by = {};
      Object.keys(su.ctx.specs).forEach(function (st) {
        var hs = o.heats.filter(function (h) { return h.steel === st; });
        if (!hs.length) return;
        by[st] = { heats: hs.length, share_pct: steelShares(o, su.ctx, st),
          pred_cu_pct: r4(hs.reduce(function (a, h) { return a + h.predCu; }, 0) / hs.length), cu_max_pct: su.ctx.specs[st].cu,
          pred_sn_pct: r5(hs.reduce(function (a, h) { return a + h.predSn; }, 0) / hs.length), sn_max_pct: su.ctx.specs[st].sn,
          max_volume_m3: Math.round(Math.max.apply(null, hs.map(function (h) { return h.vol; })) * 10) / 10 };
      });
      var bd = A.binding(su.ctx, o, mg);
      Object.keys(by).forEach(function (st) { by[st].limiting_element = bd.steel[st].limiting; });
      return { status: "ok", iteration: run.optCalls, cost_per_t_krw: Math.round(o.costPerT), total_cost_krw: Math.round(o.totalCost),
               excluded_grades: conv.nc.exclude.map(function (g) { return gradeName(g); }),
               capped_grades: Object.keys(conv.nc.cap).map(function (g) { return gradeName(g); }), by_steel: by,
               inventory_used_up: bd.inventoryLimited.map(function (g) { return gradeName(g); }),
               grade_use_t: su.ctx.grades.map(function (g, i) { return { name: gradeName(g), used_t: Math.round(bd.usage[g]), inventory_t: su.ctx.inv[i], price: su.ctx.price[i] }; }),
               note: "limiting_element는 그 강종 배합을 묶고 있는 성분 상한(상한−여유에 닿은 원소). inventory_used_up은 재고를 다 쓴 등급.",
               reason_warning: badReason.length ? badReason.join(", ") + "의 reason이 한국어 문장이 아니에요. 통지서에 그대로 실리니 다음 호출에서 한국어 한 문장으로 고쳐 주세요." : undefined };
    },
    analyze_history: function (input) {
      var topic = input.topic, opt = {};
      if (run.last) {
        var o = run.last.opt, ctx = run.su.ctx; opt.usage = A.binding(ctx, o, run.last.margins).usage; opt.byCost = {};
        Object.keys(ctx.specs).forEach(function (s) { var hs = o.heats.filter(function (h) { return h.steel === s; }); if (hs.length) opt.byCost[s] = hs.reduce(function (a, h) { return a + h.cost; }, 0) / hs.reduce(function (a, h) { return a + h.tap; }, 0); });
      }
      var out = A.history(C, run.spec, run.spec.date || null, topic, opt);
      if (!out.error && run.topics.indexOf(topic) < 0) run.topics.push(topic);
      return out;
    },
    sensitivity: function (input) {
      if (!run.last) return { error: "먼저 optimize_blend로 기준 배합을 계산하세요." };
      var res = A.sensitivity(E, run.su, run.last, window.solver, input.factor, +input.change, input.targets || [],
        { nameOf: function (g) { return gradeName(g); }, cfg: cfgFor(), nSim: N_SIM });
      if (!res.error) run.sens.push(res);
      return res;
    },
    write_report: function (input) {
      if (!run.last) return { error: "배합을 계산하기 전에는 통지서를 쓸 수 없어요." };
      if (!run.last.sim) TOOLS_IMPL.simulate_blend();
      run.report = { by: run.mode === "ai" ? "AI" : "규칙", title: input.title, summary: input.summary, reasons: input.decision_reasons || [],
                     factors: input.factor_findings || [], notesSummary: input.note_judgment_summary || "", risks: input.risks || [], recs: input.recommendations || [] };
      return { ok: true, message: "통지서를 만들었어요. 숫자 표(배합, 변인 영향, 검증 과정)는 화면이 도구 결과로 자동으로 붙여요. 이제 한두 문장으로 마무리하세요." +
        (run.last.pass === false ? " 주의: 마지막 배합은 검증 기준을 통과하지 못했어요. 마무리 문장에서 이 점을 분명히 밝히세요." : "") };
    },
    simulate_blend: function () {
      if (!run.last) return { error: "먼저 optimize_blend로 배합을 계산하세요." };
      var su = run.su, L = run.last;
      L.sim = E.simulate(su.ctx, L.opt.x, su.comp, L.nc.mult, N_SIM, L.seed);
      var sg = E.suggestMargins(L.sim, su.ctx, L.margins, gateOf(run.spec)), by = {};
      Object.keys(sg.status).forEach(function (st) {
        var rows = L.sim.filter(function (r) { return r.steel === st; });
        var w = rows.reduce(function (a, r) { return r.p_fail > a.p_fail ? r : a; }, rows[0]);
        by[st] = { max_p_fail_pct: Math.round(w.p_fail * 1000) / 10, worst_heat: w.heat_id, pass: sg.status[st].pass,
          max_p_fail_cu_pct: Math.round(Math.max.apply(null, rows.map(function (r) { return r.p_fail_cu; })) * 1000) / 10,
          max_p_fail_sn_pct: Math.round(Math.max.apply(null, rows.map(function (r) { return r.p_fail_sn; })) * 1000) / 10 };
      });
      var pass = Object.keys(sg.status).every(function (st) { return sg.status[st].pass; });
      L.pass = pass;
      return { simulations: N_SIM, target_p_fail_pct: run.spec.target * 100, pass_criterion_pct: gateOf(run.spec) * 100, all_pass: pass, by_steel: by,
               current_margins: L.margins, suggested_margins: sg.next,
               note: "pass는 최대 이탈 확률이 pass_criterion_pct 이하인지다. 같은 배합도 난수에 따라 0.3~0.4%p 오르내리니, 기준에 딱 붙은 통과는 안심할 수 없다." };
    }
  };

  function toolDefs() {
    var steels = Object.keys(run.su.ctx.specs), noteIds = run.spec.notes.map(function (n) { return n.id; });
    var mprops = {};
    steels.forEach(function (s) {
      mprops[s] = { type: "object", description: s + " 강종의 안전여유(%p). 상한에서 이만큼 뺀 값을 목표로 배합한다.",
        properties: { cu: { type: "number" }, sn: { type: "number" } }, required: ["cu", "sn"], additionalProperties: false };
    });
    var noteIdSchema = noteIds.length ? { type: "string", enum: noteIds } : { type: "string" };
    return [
      { name: "get_conditions", strict: true,
        description: "오늘 배합 조건을 읽는다: 스크랩 등급별 단가·재고·실수율·부피밀도·Cu/Sn 평균과 편차, 강종별 Cu/Sn 상한과 heat 수, 버킷 용적, 목표 이탈 확률, 검수 메모, 첫 안전여유 제안값.",
        input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
      { name: "optimize_blend", strict: true,
        description: "선형계획법으로 모든 heat의 원가 최소 배합을 한 번에 계산한다. margins는 강종별 Cu·Sn 안전여유(%p). " +
          "note_rules는 검수 메모마다 내린 판정이다: exclude=그 등급을 오늘 배합에서 제외, cap=장입 비율 5% 이하로 제한, none=평소처럼 사용. " +
          "element와 multiplier는 그 등급의 성분을 평소의 몇 배로 가정할지다(exclude·cap일 때만 의미, 보통 2).",
        input_schema: { type: "object", additionalProperties: false, required: ["margins", "note_rules"],
          properties: {
            margins: { type: "object", properties: mprops, required: steels, additionalProperties: false },
            note_rules: { type: "array", description: "검수 메모 판정. 메모가 없으면 빈 배열.",
              items: { type: "object", additionalProperties: false, required: ["note_id", "action", "element", "multiplier", "reason"],
                properties: { note_id: noteIdSchema, action: { type: "string", enum: ["exclude", "cap", "none"] },
                  element: { type: "string", enum: ["cu", "sn", "none"] }, multiplier: { type: "number" },
                  reason: { type: "string", description: "판정 이유를 한국어 한 문장으로. 통지서에 그대로 실린다. 예: 유분은 Cu·Sn 성분과 무관" } } } } } } },
      { name: "simulate_blend", strict: true,
        description: "가장 최근 optimize_blend 배합으로 몬테카를로 모의 조업을 " + N_SIM + "회 돌려 heat별 규격 이탈 확률을 계산한다. 성분 편차와 평균 추정 오차를 함께 넣는다. " +
          "통과 판정은 검증 기준(pass_criterion_pct, 목표의 75%)으로 하고, 기준을 넘은 강종에는 안전여유 조정 제안값을 준다.",
        input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
      { name: "analyze_history", strict: true,
        description: "회사 기록을 주제별로 분석한다. grade_contribution: 과거 조업 이력 500 heat로 역추정한 등급별 Cu·Sn과 공칭값 차이, 과거 배합에서 Cu가 어느 등급에서 왔는지. " +
          "spec_margin: 강종별 과거 출강 성분이 상한에 얼마나 가까웠는지, 과거 평균 배합을 오늘 단가로 사면 톤당 얼마인지. price_trend: 최근 30일 시세 변동과 Cu-가격 관계. " +
          "inventory: 재고가 평소·과거 사용량 대비 넉넉한지, 오늘 배합이 재고를 다 썼는지. notes_history: 과거 검수 메모와 성분 이상치 날짜의 관계, 키워드가 있지만 해결됐다고 적힌 메모. " +
          "power: 등급별 톤당 전력량(원가에는 미포함, 참고용).",
        input_schema: { type: "object", additionalProperties: false, required: ["topic"],
          properties: { topic: { type: "string", enum: A.TOPICS } } } },
      { name: "sensitivity", strict: true,
        description: "변인 영향 분석. 지금 배합(가장 최근 optimize_blend)을 기준으로 변인 하나만 바꿔 다시 최적화하고 원가 변화(톤당·하루), 배합 이동, 이탈 확률을 돌려준다. " +
          "factor: price(단가 % 변화), cu_mean(등급 Cu 평균 % 변화, 이탈 확률도 계산), inventory(재고 % 변화), spec_cu(강종 Cu 상한 % 변화), target_fail(change에 새 목표 이탈 확률 %를 넣음). " +
          "targets: 대상 등급 ID나 강종 이름. 빈 배열이면 해당 변인의 전체 대상을 한 번에 본다(권장).",
        input_schema: { type: "object", additionalProperties: false, required: ["factor", "change", "targets"],
          properties: { factor: { type: "string", enum: A.FACTORS }, change: { type: "number" },
            targets: { type: "array", items: { type: "string", enum: run.su.ctx.grades.concat(steels) } } } } },
      { name: "write_report", strict: true,
        description: "최종 배합이 정해지면 결재권자(제강팀장)에게 보낼 '배합 결정 통지서'를 쓴다. 숫자 표(배합, 변인 영향, 검증 과정)는 화면이 도구 결과로 자동으로 붙이므로, " +
          "여기에는 판단과 설명을 쓴다. 숫자를 쓸 때는 도구 결과에 있는 값만 쓴다. 모든 문장은 한국어, 담당자가 팀장에게 보고하듯 간결하고 자연스럽게.",
        input_schema: { type: "object", additionalProperties: false,
          required: ["title", "summary", "decision_reasons", "factor_findings", "note_judgment_summary", "risks", "recommendations"],
          properties: {
            title: { type: "string", description: "통지서 제목. 예: 9/29 배합 결정 — 중량A·경량A 재고 소진, Cu 상한 기준" },
            summary: { type: "string", description: "3~4문장 요약: 무엇을 정했고, 원가와 이탈 확률은 얼마인지" },
            decision_reasons: { type: "array", items: { type: "string" }, description: "이 배합으로 정한 이유 3~6개. 묶고 있는 제약, 단가-성분 관계, 재고, 메모 판정을 근거로" },
            factor_findings: { type: "array", description: "기록 분석과 변인 영향에서 알게 된 것 3~6개",
              items: { type: "object", additionalProperties: false, required: ["factor", "finding", "effect"],
                properties: { factor: { type: "string", description: "변인 이름. 예: 중량A 단가" }, finding: { type: "string", description: "분석에서 본 사실(숫자 포함)" },
                  effect: { type: "string", description: "그래서 배합에 어떤 영향을 줬나 / 줄 수 있나" } } } },
            note_judgment_summary: { type: "string", description: "검수 메모를 어떻게 판단했는지 1~3문장. 메모가 없으면 '메모 없음'" },
            risks: { type: "array", description: "남은 위험과 대응 1~4개",
              items: { type: "object", additionalProperties: false, required: ["risk", "action"], properties: { risk: { type: "string" }, action: { type: "string" } } } },
            recommendations: { type: "array", items: { type: "string" }, description: "구매·재고·검수에 대한 제안 1~4개" } } } }
    ];
  }
  function systemPrompt() {
    return "당신은 전기로 제강사 리본스틸(가상 기업)의 스크랩 배합 AI 에이전트입니다.\n" +
      "목표: 주어진 조건에서 모든 heat의 규격 이탈 확률을 목표 이하로 지키면서 톤당 배합 원가가 가장 낮은 스크랩 배합을 찾습니다. " +
      "모의 조업의 통과 판정은 추정 오차를 감안한 검증 기준(목표의 75%)으로 합니다.\n\n" +
      "최종 산출물은 결재권자에게 보내는 '배합 결정 통지서'입니다. 왜 이 배합으로 정했는지를 기록과 계산 근거로 설명해야 합니다.\n\n" +
      "작업 순서\n" +
      "1. get_conditions로 조건을 읽습니다.\n" +
      "2. analyze_history로 기록을 봅니다. grade_contribution, price_trend, inventory, notes_history는 꼭 보고, 필요하면 spec_margin, power도 봅니다. 한 번에 여러 도구를 같이 불러도 됩니다.\n" +
      "3. 검수 메모를 하나씩 판단합니다. Cu·Sn 원천(모터, 전선, 구리코일, 황동, 주석도금 캔, 비철 선별 불량 등)이 실제로 섞였다고 적혀 있으면 exclude, " +
      "가능성만 언급되면 cap, 성분과 무관하거나(유분·수분·녹·부피) '제거 완료', '분석 결과 정상'처럼 이미 해결됐다고 적혀 있으면 none입니다. notes_history의 과거 사례도 참고하세요.\n" +
      "4. 제안된 첫 안전여유와 메모 판정으로 optimize_blend를 부르고, 바로 simulate_blend로 검증합니다.\n" +
      "5. 검증 기준을 넘는 강종이 있으면 그 강종의 안전여유만 키워 다시 최적화합니다. suggested_margins를 참고하되 판단은 직접 하세요. 통과한 강종의 여유를 괜히 키우면 원가가 오릅니다. " +
      "최적화는 최대 " + MAX_OPT + "번입니다. 배합이 불가능하다고 나오면 원인을 짐작해 조정합니다.\n" +
      "   검증 기준(pass_criterion_p_fail)은 목표 이탈 확률보다 낮게 잡혀 있습니다. 모의 조업은 과거 이력으로 추정한 성분으로 돌리는데, 추정이 실제보다 낮은 등급이 있으면 " +
      "실제 이탈이 모의 조업보다 높게 나오기 때문입니다(검증 기간 정답 채점에서 확인한 사실). 그러니 통과 판정은 반드시 all_pass로 하고, '목표 2%보다 낮으니 여유가 지나치다'는 이유로 여유를 깎지 마세요. " +
      "이미 통과한 강종의 여유를 줄이는 것은 최대 이탈이 검증 기준의 절반에도 못 미칠 때만 하고, 줄인 뒤에는 반드시 다시 검증합니다. 같은 여유로 두 번 계산하지 마세요.\n" +
      "6. 모두 통과하면 sensitivity로 변인 영향을 봅니다. 최소한 price(+10%, 전체), cu_mean(+20%, 전체)를 보고, 재고를 다 쓴 등급이 있으면 inventory(+20%), 필요하면 target_fail이나 spec_cu도 봅니다. " +
      "sensitivity는 배합을 바꾸지 않으니, 마지막 optimize_blend 결과가 최종 배합입니다.\n" +
      "7. write_report로 통지서를 씁니다. 이유는 '무엇이 이 배합을 묶고 있나'(limiting_element, inventory_used_up), 등급별 단가와 Cu의 관계, 기록에서 본 사실, 변인 영향의 크기로 설명하세요.\n" +
      "8. 통지서를 쓴 뒤 한두 문장으로 마무리합니다.\n\n" +
      "규칙: 숫자는 도구 결과에 있는 값만 쓰고 지어내지 마세요. 도구를 부르기 전에 무엇을 하려는지 한두 문장으로 짧게 말해 주세요.";
  }

  /* ====================================================================
     4. 실행: AI 에이전트 / AI 없이
     AI 연결은 세 갈래다. 도구·화면·통지서는 같고, 모델을 부르는 부분만 다르다.
       - TimelyGPT 연동 키(tgpt_sk_…) + Claude 모델 → TimelyGPT Direct API의 Anthropic 형식 주소 (/v1/messages)
       - TimelyGPT 연동 키(tgpt_sk_…) + GPT 모델    → TimelyGPT Direct API의 OpenAI 형식 주소 (/chat/completions)
       - Claude 키(sk-ant-…)                        → Anthropic 공식 SDK
     TimelyGPT 서버는 브라우저 호출에 Content-Type·Authorization 헤더만 허용해서(CORS), 그쪽은 SDK 대신 fetch로 부른다.
     ==================================================================== */
  var busy = false;
  function emit(ev) { run.events.push(ev); if (!presenting) appendEvent(ev, run.events.length - 1); }

  var TIMELY = "https://hello.timelyai.io/api/v2/chat/direct";
  var MODELS = {
    timely: [["claude-opus-5-5", "Claude Opus 5.5"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-haiku-5-5", "Claude Haiku 5.5"], ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
             ["gpt-5.5", "GPT-5.5"], ["gpt-5.4", "GPT-5.4"], ["gpt-5.1", "GPT-5.1"], ["gpt-4.1", "GPT-4.1"]],
    anthropic: [["claude-opus-5-5", "Claude Opus 5.5"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-haiku-5-5", "Claude Haiku 5.5"]]
  };
  function keyKind(k) { return /^tgpt_sk_/.test(k) ? "timely" : /^sk-ant-/.test(k) ? "anthropic" : null; }
  function wireOf(model) { return /^claude-/.test(model) ? "anthropic" : "openai"; }
  function modelLabel(id) {
    var all = MODELS.timely.concat(MODELS.anthropic), hit = all.filter(function (m) { return m[0] === id; })[0];
    if (hit) return hit[1];
    return String(id).replace(/^claude-/, "Claude ").replace(/^gpt-/, "GPT-");
  }
  function httpErr(status, msg) { var e = new Error(msg); e.status = status; e.http = true; return e; }
  async function postJson(url, key, body) {
    var res;
    try { res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key }, body: JSON.stringify(body) }); }
    catch (e) { throw httpErr(0, "TimelyGPT 서버에 연결하지 못했어요. 인터넷 연결을 확인하세요."); }
    var txt = await res.text(), j = null;
    try { j = JSON.parse(txt); } catch (e) { /* JSON이 아닌 응답 */ }
    if (!res.ok) throw httpErr(res.status, j && j.error ? (j.error.message || JSON.stringify(j.error)) : String(txt || "").slice(0, 200));
    if (!j) throw httpErr(res.status, "응답을 읽지 못했어요: " + String(txt || "").slice(0, 120));
    return j;
  }
  function normAnthropic(r) {
    var blocks = [];
    (r.content || []).forEach(function (b) {
      if (b.type === "thinking" && b.thinking) blocks.push({ type: "thinking", text: b.thinking });
      else if (b.type === "text") blocks.push({ type: "text", text: b.text || "" });
      else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input || {} });
    });
    var u = r.usage || {}, s = r.stop_reason;
    return { blocks: blocks, raw: r, usage: { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheR: u.cache_read_input_tokens || 0, cacheW: u.cache_creation_input_tokens || 0 },
             stop: s === "tool_use" ? "tool" : s === "max_tokens" ? "max" : s === "refusal" ? "refusal" : s === "pause_turn" ? "pause" : "end" };
  }
  function anthropicHistory() {
    var messages = [];
    return {
      messages: messages,
      start: function (u) { messages.push({ role: "user", content: u }); },
      pushAssistant: function (n) { messages.push({ role: "assistant", content: n.raw.content }); },   // 생각 블록까지 그대로 돌려준다
      pushResults: function (rs) { messages.push({ role: "user", content: rs.map(function (x) { return { type: "tool_result", tool_use_id: x.id, content: x.content, is_error: x.isErr }; }) }); }
    };
  }
  // Claude 키로 공식 SDK
  function sdkProvider(Anthropic, key, model, system, tools) {
    var client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }), h = anthropicHistory();
    return Object.assign(h, { label: modelLabel(model), kind: "anthropic",
      send: async function () {
        var r = await client.beta.messages.create({ model: model, max_tokens: 16000, system: system, tools: tools, messages: h.messages,
          thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
        return normAnthropic(r);
      } });
  }
  // TimelyGPT 연동 키 + Claude 모델: Anthropic 형식. 서버가 받지 않는 옵션이 있으면(400) 하나씩 빼고 다시 보낸다.
  function timelyAnthropic(key, model, system, tools) {
    var h = anthropicHistory(), level = 0;
    function body() {
      var b = { model: model, max_tokens: 16000, system: system, messages: h.messages,
                tools: level >= 3 ? tools.map(function (t) { var c = Object.assign({}, t); delete c.strict; return c; }) : tools };
      if (level < 2) b.thinking = { type: "adaptive", display: "summarized" };
      else if (level < 3) b.thinking = { type: "adaptive" };
      if (level < 1) b.output_config = { effort: "medium" };
      return b;
    }
    return Object.assign(h, { label: modelLabel(model) + " · TimelyGPT", kind: "timely",
      send: async function () {
        for (;;) {
          try { return normAnthropic(await postJson(TIMELY + "/anthropic/v1/messages", key, body())); }
          catch (e) { if (e.status === 400 && level < 3) { level++; continue; } throw e; }
        }
      } });
  }
  // TimelyGPT 연동 키 + GPT 모델: OpenAI Chat Completions 형식
  function timelyOpenAI(key, model, system, tools) {
    var messages = [{ role: "system", content: system }], level = 0;
    var oTools = tools.map(function (t) { return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }; });
    return { label: modelLabel(model) + " · TimelyGPT", kind: "timely",
      start: function (u) { messages.push({ role: "user", content: u }); },
      send: async function () {
        var r;
        for (;;) {
          var b = { model: model, messages: messages, tools: oTools };
          if (level < 1) { b.tool_choice = "auto"; b.max_completion_tokens = 16000; }
          try { r = await postJson(TIMELY + "/openai/v1/chat/completions", key, b); break; }
          catch (e) { if (e.status === 400 && level < 1) { level++; continue; } throw e; }
        }
        var ch = r.choices && r.choices[0]; if (!ch) throw httpErr(200, "응답에 내용이 없어요.");
        var m = ch.message || {}, blocks = [], calls = m.tool_calls || [];
        if (m.reasoning_content) blocks.push({ type: "thinking", text: String(m.reasoning_content) });
        if (m.content) blocks.push({ type: "text", text: String(m.content) });
        calls.forEach(function (tc) {
          var inp; try { inp = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (e) { inp = { __badJson: true }; }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function && tc.function.name, input: inp });
        });
        var fr = ch.finish_reason, u = r.usage || {};
        return { blocks: blocks, raw: m, usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0, cacheR: 0, cacheW: 0 },
                 stop: calls.length ? "tool" : fr === "length" ? "max" : fr === "content_filter" ? "refusal" : "end" };
      },
      pushAssistant: function (n) {
        var a = { role: "assistant", content: n.raw.content || "" };
        if (n.raw.tool_calls && n.raw.tool_calls.length) a.tool_calls = n.raw.tool_calls;
        messages.push(a);
      },
      pushResults: function (rs) { rs.forEach(function (x) { messages.push({ role: "tool", tool_call_id: x.id, content: x.content }); }); }
    };
  }
  // 상태 코드별 안내 (TimelyGPT Direct API 문서의 오류 표 기준)
  function errorText(err, kind) {
    var s = err && err.status, m = err && err.message ? String(err.message).slice(0, 200) : String(err);
    if (s === 401) return kind === "timely" ? "연동 키가 올바르지 않아요. 키를 재발급했다면 예전 키는 더 이상 쓸 수 없어요. (" + m + ")" : "API 키가 올바르지 않아요. 키를 다시 확인해 주세요.";
    if (s === 402) return "크레딧이 부족하거나 사용 한도를 넘었어요. 스페이스 관리자에게 문의해 주세요. (" + m + ")";
    if (s === 403) return "이 모델은 스페이스나 그룹에서 꺼져 있거나, 지금 접속한 IP가 허용되지 않았어요. 다른 모델을 골라 보거나 관리자에게 문의해 주세요. (" + m + ")";
    if (s === 404) return "이 모델이나 주소를 쓸 수 없어요. '모델 목록 불러오기'로 쓸 수 있는 모델을 확인해 주세요. (" + m + ")";
    if (s === 429) return "요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.";
    if (s === 400) return "요청 형식 오류: " + m;
    if (s >= 500) return "모델 서버 연결이 잠시 안 돼요 (" + s + "). 잠시 뒤 다시 시도해 주세요.";
    if (s === 0 || /connection|network|fetch/i.test(m)) return kind === "timely" ? "TimelyGPT 서버에 연결하지 못했어요. 인터넷 연결을 확인하세요." : "Claude 서버에 연결하지 못했어요. 인터넷 연결을 확인하세요.";
    return "실행 중 오류: " + m;
  }
  // 이 키로 쓸 수 있는 모델 목록 (키 확인도 겸한다)
  async function loadModels() {
    var key = apiKey(), kind = keyKind(key);
    if (kind !== "timely") { setStatus(kind === "anthropic" ? "Claude 키는 목록 없이 위 모델 중에서 고르면 돼요." : "TimelyGPT 연동 키(tgpt_sk_로 시작)를 먼저 넣어 주세요.", !kind); return; }
    setStatus("쓸 수 있는 모델을 확인하는 중…");
    var found = [], errs = [];
    for (var path of ["/anthropic/v1/models", "/openai/v1/models"]) {
      try {
        var res = await fetch(TIMELY + path, { headers: { "Authorization": "Bearer " + key } });
        var j = await res.json().catch(function () { return null; });
        if (!res.ok) { errs.push(res.status); continue; }
        ((j && j.data) || []).forEach(function (m) { if (m && m.id && (/^claude-/.test(m.id) || /^(gpt-|o\d)/.test(m.id)) && !/-pro$|codex/.test(m.id)) found.push(m.id); });
      } catch (e) { errs.push(0); }
    }
    if (!found.length) { setStatus(errs.indexOf(401) >= 0 ? errorText({ status: 401, message: "인증 실패" }, "timely") : "모델 목록을 받지 못했어요 (" + errs.join(", ") + "). 아래 기본 목록에서 골라 시도해 보세요.", true); return; }
    var cur = $("model").value;
    $("model").innerHTML = found.map(function (id) { return '<option value="' + esc(id) + '">' + esc(modelLabel(id)) + "</option>"; }).join("");
    $("model").value = found.indexOf(cur) >= 0 ? cur : (found.filter(function (id) { return /^claude-opus|^claude-sonnet/.test(id); })[0] || found[0]);
    setStatus("이 키로 쓸 수 있는 모델 " + found.length + "개를 불러왔어요.");
  }
  function drawModelOptions() {
    var kind = keyKind(apiKey()) || "timely", cur = $("model").value || P.store.get("rb-model", "claude-opus-5-5");
    $("model").innerHTML = MODELS[kind].map(function (m) { return '<option value="' + m[0] + '">' + esc(m[1]) + "</option>"; }).join("");
    $("model").value = MODELS[kind].some(function (m) { return m[0] === cur; }) ? cur : MODELS[kind][0][0];
    $("modelsBtn").hidden = kind !== "timely";
  }

  function getSdk() {
    if (window.Anthropic) return Promise.resolve(window.Anthropic);
    return new Promise(function (ok, fail) {
      var t = setTimeout(function () { fail(new Error("Claude SDK를 불러오지 못했어요. 인터넷 연결을 확인하세요.")); }, 15000);
      window.addEventListener("anthropic-ready", function () { clearTimeout(t); ok(window.Anthropic); }, { once: true });
    });
  }
  function apiKey() { var k = $("apiKey").value.trim(); return k; }

  async function runAgent() {
    var key = apiKey(), kind = keyKind(key), model = $("model").value;
    if (!key) { setStatus("AI 연동 키를 넣어 주세요. 키가 없으면 'AI 없이 계산'을 눌러요.", true); $("apiKey").focus(); return; }
    if (/[^\x21-\x7e]/.test(key)) { setStatus("키에 공백이나 한글이 섞여 있어요. 키만 다시 붙여 넣어 주세요.", true); return; }
    if (!kind) { setStatus("TimelyGPT 연동 키(tgpt_sk_로 시작) 또는 Claude 키(sk-ant-로 시작)를 넣어 주세요.", true); return; }
    if (kind === "anthropic" && wireOf(model) !== "anthropic") { setStatus("Claude 키로는 Claude 모델만 쓸 수 있어요. 모델을 바꿔 주세요.", true); return; }
    rememberKey(key);
    var Anthropic = null;
    if (kind === "anthropic") { try { Anthropic = await getSdk(); } catch (e) { setStatus(e.message, true); return; } }
    start("ai");                                   // 도구 정의는 이번 실행의 조건(run)으로 만든다
    var tools = toolDefs(), system = systemPrompt();
    var prov = kind === "anthropic" ? sdkProvider(Anthropic, key, model, system, tools)
             : wireOf(model) === "anthropic" ? timelyAnthropic(key, model, system, tools) : timelyOpenAI(key, model, system, tools);
    run.kind = kind; run.model = model; run.agentLabel = prov.label;
    drawUsage();
    prov.start("오늘 조건으로 스크랩 배합을 설계하고, 배합 결정 통지서까지 써 주세요. 조건은 get_conditions로 읽을 수 있어요.");
    try {
      for (var turn = 1; turn <= MAX_TURNS; turn++) {
        setStatus("AI가 생각하는 중… (" + prov.label + ", " + turn + "번째 호출)");
        showWaiting(true);
        var n = await prov.send();
        showWaiting(false);
        run.usage.in += n.usage.in; run.usage.out += n.usage.out; run.usage.cacheR += n.usage.cacheR; run.usage.cacheW += n.usage.cacheW;
        drawUsage();
        prov.pushAssistant(n);
        n.blocks.forEach(function (b) {
          if (b.type === "thinking" && b.text.trim()) emit({ t: "thinking", text: b.text.trim() });
          else if (b.type === "text" && b.text.trim()) emit({ t: "text", text: b.text.trim() });
          else if (b.type === "tool_use") emit({ t: "call", name: b.name, input: b.input });
        });
        if (n.stop === "refusal") { finish("error", "AI가 이 요청을 거절했어요."); return; }
        if (n.stop === "max") { finish("error", "응답이 길어서 중간에 잘렸어요. 크레딧이 적으면 출력이 짧게 잘릴 수 있어요. 다시 실행해 주세요."); return; }
        if (n.stop === "pause") continue;
        if (n.stop !== "tool") {
          run.conclusion = n.blocks.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n").trim();
          finish(run.last ? "done" : "error", run.last ? "" : "배합을 계산하기 전에 대화가 끝났어요.");
          return;
        }
        var results = [];
        n.blocks.forEach(function (b) {
          if (b.type !== "tool_use") return;
          var out, isErr = false;
          try {
            out = b.input && b.input.__badJson ? { error: "도구 입력(JSON)을 읽지 못했어요. 형식을 지켜 다시 불러 주세요." }
                : TOOLS_IMPL[b.name] ? TOOLS_IMPL[b.name](b.input || {}) : { error: "없는 도구: " + b.name };
            isErr = !!out.error;
          } catch (e) { out = { error: String(e.message || e) }; isErr = true; }
          emit({ t: "result", name: b.name, out: out, err: isErr });
          results.push({ id: b.id, content: JSON.stringify(out), isErr: isErr });
        });
        prov.pushResults(results);   // 결과는 한 번에 모아서
      }
      finish(run.last ? "done" : "error", "호출 횟수 한도(" + MAX_TURNS + "번)에 닿아 멈췄어요.");
    } catch (err) {
      showWaiting(false);
      finish("error", errorText(err, kind));
    }
  }

  // AI 없이: 메모는 키워드 규칙, 안전여유는 정해진 규칙으로 반복
  function runPlain() {
    start("plain");
    try { plainLoop(); } catch (e) { finish("error", "계산 중 오류: " + (e && e.message ? e.message : e)); }
  }
  function plainLoop() {
    var su = run.su, notes = run.spec.notes;
    var kw = E.keywordJudge(notes.map(function (n) { return { lot_id: n.id, grade_id: n.grade, note_text: n.text }; }), C.config);
    var rules = kw.map(function (f) { return { note_id: f.lot_id, action: f.risk === "high" ? "exclude" : "none", element: f.element, multiplier: f.suspected_multiplier, reason: "키워드 규칙" }; });
    emit({ t: "text", text: "AI 없이 계산해요. 검수 메모는 키워드 규칙으로 판정하고, 안전여유는 정해진 규칙(모자란 만큼 키우기)으로 조정해요." });
    emit({ t: "call", name: "get_conditions", input: {} });
    var cond = TOOLS_IMPL.get_conditions(); emit({ t: "result", name: "get_conditions", out: cond });
    var margins = cond.initial_margin_suggestion;
    for (var i = 1; i <= MAX_OPT; i++) {
      var inp = { margins: margins, note_rules: rules };
      emit({ t: "call", name: "optimize_blend", input: inp });
      var o = TOOLS_IMPL.optimize_blend(inp); emit({ t: "result", name: "optimize_blend", out: o, err: o.status !== "ok" && o.status !== "duplicate" });
      if (o.status === "duplicate") break;
      if (o.status !== "ok") {
        var shrunk = {}; Object.keys(margins).forEach(function (s) { shrunk[s] = { cu: r5(margins[s].cu * 0.8), sn: r5(margins[s].sn * 0.8) }; });
        margins = shrunk; continue;
      }
      emit({ t: "call", name: "simulate_blend", input: {} });
      var sres = TOOLS_IMPL.simulate_blend(); emit({ t: "result", name: "simulate_blend", out: sres });
      if (sres.all_pass) break;
      margins = sres.suggested_margins;
    }
    if (run.last) {
      // 기록 분석과 변인 영향도 정해진 순서로 같은 도구를 부른다
      ["grade_contribution", "price_trend", "inventory", "notes_history", "spec_margin"].forEach(function (t) { callTool("analyze_history", { topic: t }); });
      var bd = A.binding(su.ctx, run.last.opt, run.last.margins);
      callTool("sensitivity", { factor: "price", change: 10, targets: [] });
      callTool("sensitivity", { factor: "cu_mean", change: 20, targets: [] });
      if (bd.inventoryLimited.length) callTool("sensitivity", { factor: "inventory", change: 20, targets: bd.inventoryLimited });
      var tr = templateReport(run);
      callTool("write_report", { title: tr.title, summary: tr.summary, decision_reasons: tr.reasons, factor_findings: tr.factors,
        note_judgment_summary: tr.notesSummary, risks: tr.risks, recommendations: tr.recs });
      run.report.by = "규칙";
    }
    run.conclusion = run.last ? "키워드 규칙과 정해진 조정 규칙으로 계산하고, 통지서는 정해진 틀에 숫자를 채워 썼어요. 메모의 문맥(예: '전량 제거 완료')은 읽지 못하니, 판정이 이상하면 AI로 다시 풀어 보세요." : "";
    finish(run.last ? "done" : "error", run.last ? "" : "조건을 만족하는 배합을 찾지 못했어요.");
  }
  function callTool(name, input) {
    emit({ t: "call", name: name, input: input });
    var out = TOOLS_IMPL[name](input); emit({ t: "result", name: name, out: out, err: !!out.error });
    return out;
  }

  // 받침에 맞는 조사 (은/는, 이/가). 영문·숫자는 읽는 소리 기준: SD600(육)은, Sn(엔)이, Cu(유)가
  function josa(word, pair) {
    var c = String(word).trim().slice(-1), code = c.charCodeAt(0), has;
    if (code >= 0xac00 && code <= 0xd7a3) has = (code - 0xac00) % 28 !== 0;
    else if (/[0-9]/.test(c)) has = "013678".indexOf(c) >= 0;
    else has = /[lmnrLMNR]/.test(c);
    return word + (has ? pair[0] : pair[1]);
  }
  /* 규칙 기반 통지서: AI 없이 계산했거나, AI가 통지서를 쓰지 않고 끝냈을 때 숫자로 채운다 */
  function templateReport(r) {
    var L = r.last, su = r.su, ctx = su.ctx, o = L.opt, nm = function (g) { return gradeName(g, r.spec); };
    if (!L.sim) L.sim = E.simulate(ctx, o.x, su.comp, L.nc.mult, N_SIM, L.seed);
    var bd = A.binding(ctx, o, L.margins), mp = Math.max.apply(null, L.sim.map(function (x) { return x.p_fail; })) * 100;
    var worst = L.sim.reduce(function (a, x) { return x.p_fail > a.p_fail ? x : a; }, L.sim[0]);
    var expert = E.canExpert(ctx, cfgFor()) ? E.expertBlend(ctx, su.comp, cfgFor()) : null;
    var tap = o.heats.reduce(function (a, h) { return a + h.tap; }, 0);
    var sens = function (f) { return r.sens.filter(function (s) { return s.factor === f; })[0]; };
    var day = r.spec.date ? P.md(r.spec.date) : "직접 입력 조건";
    var reasons = [], factors = [], risks = [], recs = [];

    var lim = {}; Object.keys(bd.steel).forEach(function (s) { var k = bd.steel[s].limiting; (lim[k] = lim[k] || []).push(s); });
    Object.keys(lim).forEach(function (k) {
      if (k === "없음") reasons.push(josa(lim[k].join("·"), ["은", "는"]) + " 성분 상한에 닿기 전에 다른 제약(재고·용적)에 먼저 걸렸어요.");
      else reasons.push(josa(lim[k].join("·"), ["은", "는"]) + " " + k + " 상한(상한 − 안전여유)에 닿을 때까지 싼 등급을 넣었어요. 더 싸게 하려면 " + josa(k, ["이", "가"]) + " 넘쳐요.");
    });
    if (bd.inventoryLimited.length) reasons.push(josa(bd.inventoryLimited.map(nm).join("·"), ["은", "는"]) + " 재고를 다 썼어요. 성분 대비 싼 등급이라 재고가 더 있었다면 더 썼을 거예요.");
    var unused = ctx.grades.filter(function (g) { return bd.usage[g] < 0.5 && L.nc.exclude.indexOf(g) < 0; });
    if (unused.length) reasons.push(josa(unused.map(nm).join("·"), ["은", "는"]) + " 쓰지 않았어요. 같은 성분을 더 싸게 맞추는 조합이 있었어요.");
    if (L.nc.exclude.length) reasons.push(josa(L.nc.exclude.map(nm).join("·"), ["은", "는"]) + " 검수 메모 때문에 오늘 배합에서 뺐어요.");
    reasons.push("안전여유는 Cu 기준 " + Object.keys(L.margins).map(function (s) { return s + " " + (+L.margins[s].cu).toFixed(3) + "%p"; }).join(", ") + "로, 모의 조업에서 모든 강종이 검증 기준(" + pct(gateOf(r.spec)) + "%, 목표 " + pct(r.spec.target) + "%) 안에 들어온 값이에요. 성분 추정이 틀릴 수 있어 목표보다 낮은 기준으로 검증했어요.");

    var sp = sens("price"), sc = sens("cu_mean"), si = sens("inventory");
    if (sp && sp.rows[0] && sp.rows[0].feasible) { var a = sp.rows[0];
      factors.push({ factor: a.target + " 단가", finding: "10% 오르면 톤당 " + won(a.delta_krw_per_t) + "원 오른다" + (a.delta_if_blend_fixed_krw_per_t !== a.delta_krw_per_t ? " (배합을 그대로 두면 " + won(a.delta_if_blend_fixed_krw_per_t) + "원)" : "") + ".",
        effect: "오늘 원가에 가장 민감한 등급이에요." + (a.shifts.length ? " 오르면 " + a.shifts.join(", ") + "로 바뀌어요." : " 올라도 다른 등급으로 바꾸지 않을 만큼 유리해요.") }); }
    if (sc && sc.rows[0]) { var c = sc.rows.slice().sort(function (x, y) { return (y.max_p_fail_if_blend_fixed_pct || 0) - (x.max_p_fail_if_blend_fixed_pct || 0); })[0];
      factors.push({ factor: c.target + " Cu 함량", finding: "평소보다 20% 높게 들어오면 배합을 그대로 둘 때 최대 이탈 확률이 " + c.max_p_fail_if_blend_fixed_pct + "%가 된다.",
        effect: "Cu 쪽 위험이 가장 큰 등급이에요. 다시 최적화하면 톤당 " + won(c.delta_krw_per_t) + "원 더 들고 이탈 확률은 " + c.max_p_fail_pct + "%예요." });
      if (c.max_p_fail_if_blend_fixed_pct > r.spec.target * 100) risks.push({ risk: c.target + " 로트의 Cu가 평소보다 높게 들어올 수 있어요 (20% 높으면 이탈 " + c.max_p_fail_if_blend_fixed_pct + "%).", action: c.target + " 입고 로트의 검수 메모와 1차 성분 분석을 먼저 확인해요." }); }
    if (si) si.rows.forEach(function (x) { if (x.feasible && x.delta_krw_per_t < 0) {
      factors.push({ factor: x.target + " 재고", finding: "20% 더 있으면 톤당 " + won(-x.delta_krw_per_t) + "원(하루 " + Math.round(-x.delta_krw_per_day / 1e4).toLocaleString("ko-KR") + "만 원) 싸진다.", effect: "재고가 배합을 묶고 있어요." });
      recs.push(x.target + " 재고를 20% 더 확보하면 하루 약 " + Math.round(-x.delta_krw_per_day / 1e4).toLocaleString("ko-KR") + "만 원 아낄 수 있어요. 구매팀과 발주를 검토해 주세요."); } });
    var inv = A.history(C, r.spec, r.spec.date || null, "inventory", { usage: bd.usage });
    (inv.grades || []).filter(function (g) { return g.status === "부족"; }).forEach(function (g) { recs.push(g.name + " 재고가 " + g.input_inventory_t + "t로 과거 하루 사용량(" + g.past_daily_use_t + "t)에 비해 적어요. 다음 배합 전에 입고 일정을 확인해 주세요."); });

    risks.unshift({ risk: worst.heat_id + " " + worst.steel + "의 예측 이탈 확률이 " + (worst.p_fail * 100).toFixed(1) + "%로 가장 높아요.", action: "장입 후 1차 성분 분석 결과를 바로 확인해요." });
    var notesSummary = r.spec.notes.length ? "검수 메모 " + r.spec.notes.length + "건을 키워드 규칙으로 판정했어요. " +
      (L.nc.exclude.length ? josa(L.nc.exclude.map(nm).join("·"), ["은", "는"]) + " Cu·Sn 관련 단어가 있어 뺐어요. 규칙은 '제거 완료' 같은 문맥을 읽지 못하니 원문 확인이 필요해요." : "제외한 등급은 없어요.") : "메모 없음";
    if (L.nc.exclude.length) risks.push({ risk: "키워드 규칙이 이미 해결된 메모까지 위험으로 봤을 수 있어요.", action: "품질보증팀과 메모 원문을 확인하고, 필요하면 AI로 다시 풀어요." });
    if (!recs.length) recs.push("오늘 조건에서는 따로 조치할 구매·재고 항목이 없어요.");

    return { title: day + " 배합 결정 — 톤당 " + won(o.costPerT) + "원, 최대 이탈 " + mp.toFixed(1) + "%",
      summary: ctx.plan.length + " heat 배합을 톤당 " + won(o.costPerT) + "원(하루 " + (o.totalCost / 1e8).toFixed(2) + "억 원)으로 정했어요. 모의 조업 " + N_SIM.toLocaleString("ko-KR") + "회 기준 최대 이탈 확률은 " + mp.toFixed(1) + "%로 검증 기준 " + pct(gateOf(r.spec)) + "% " + (mp <= gateOf(r.spec) * 100 + 1e-9 ? "안이에요." : "를 넘어요.") +
        (expert ? " 숙련자 배합보다 톤당 " + won(expert.costPerT - o.costPerT) + "원(하루 약 " + Math.round((expert.costPerT - o.costPerT) * tap / 1e4).toLocaleString("ko-KR") + "만 원) 싸요." : ""),
      reasons: reasons, factors: factors, notesSummary: notesSummary, risks: risks, recs: recs };
  }

  function start(mode) {
    busy = true; presenting = false; $("tl").classList.remove("present");
    run = newRun(mode);
    $("tl").innerHTML = ""; $("tlBox").hidden = false; $("resBox").hidden = true; $("reportBox").hidden = true; $("replayBar").hidden = true;
    $("aiBtn").disabled = $("plainBtn").disabled = true;
    drawUsage();
    $("tlBox").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }
  function finish(status, msg) {
    busy = false; showWaiting(false);
    run.status = status;
    if (msg) emit({ t: "error", text: msg });
    if (status === "done") { emit({ t: "done", text: run.conclusion }); setStatus(run.mode === "ai" ? "AI 에이전트가 배합을 다 풀었어요. (" + run.agentLabel + ")" : "계산을 마쳤어요."); }
    else setStatus(msg || "실행을 마치지 못했어요.", true);
    showErrors();
    if (run.last && !run.report) {     // AI가 통지서를 쓰지 않고 끝났으면 숫자로 채운 기본 통지서
      var tr = templateReport(run);
      run.report = { by: "규칙", fallback: true, title: tr.title, summary: tr.summary, reasons: tr.reasons, factors: tr.factors, notesSummary: tr.notesSummary, risks: tr.risks, recs: tr.recs };
    }
    if (run.last) { drawResult(run); drawReport(run); saveRun(run); }
    else $("reportBox").hidden = true;
    dirty = false; drawSaved();
    $("replayBar").hidden = false;
  }

  /* ====================================================================
     5. 과정(타임라인) 그리기
     ==================================================================== */
  var TOOL_KO = { get_conditions: "조건 읽기", optimize_blend: "원가 최소 배합 계산", simulate_blend: "모의 조업 검증",
                  analyze_history: "기록 분석", sensitivity: "변인 영향 분석", write_report: "통지서 작성" };
  var TOPIC_KO = { grade_contribution: "등급별 성분과 Cu 기여", spec_margin: "강종별 규격 여유와 과거 배합 원가", price_trend: "시세 추이와 Cu-가격 관계",
                   inventory: "재고 수준", notes_history: "과거 검수 메모와 이상치", power: "등급별 전력량" };
  var FACTOR_KO = { price: "단가", cu_mean: "Cu 함량", inventory: "재고", spec_cu: "Cu 상한", target_fail: "목표 이탈 확률" };
  function signed(v) { return (v > 0 ? "+" : v < 0 ? "−" : "") + won(Math.abs(v)); }
  function factorLabel(f, ch) { return FACTOR_KO[f] + (f === "target_fail" ? " " + ch + "%" : " " + (ch > 0 ? "+" : "") + ch + "%"); }
  function historyBrief(o) {
    var pick = function (arr, key, desc) { return arr.slice().sort(function (a, b) { return desc ? b[key] - a[key] : a[key] - b[key]; })[0]; };
    if (o.topic === "grade_contribution") {
      var hi = pick(o.grades, "est_vs_nominal_cu_pct", true), top = pick(o.grades, "share_of_total_cu_pct", true);
      return "회귀 R² " + o.fit.r2_cu + " · 공칭보다 Cu가 가장 높게 추정된 등급 <b>" + esc(hi.name) + " " + (hi.est_vs_nominal_cu_pct > 0 ? "+" : "") + hi.est_vs_nominal_cu_pct + "%</b> · 과거 배합 Cu의 " + top.share_of_total_cu_pct + "%가 " + esc(top.name) + "에서";
    }
    if (o.topic === "spec_margin") return Object.keys(o.steels).map(function (s) { var v = o.steels[s];
      return '<span class="pill mute">' + esc(s) + " 과거 Cu p95 " + v.cu.p95.toFixed(3) + "/" + v.cu.limit + (v.past_avg_blend_cost_today_krw_per_t ? " · 과거 배합 " + won(v.past_avg_blend_cost_today_krw_per_t) + "원/t" : "") + "</span>"; }).join(" ");
    if (o.topic === "price_trend") {
      var mv = o.grades.filter(function (g) { return g.chg_7d_pct != null; });
      var big = mv.length ? mv.slice().sort(function (a, b) { return Math.abs(b.chg_7d_pct) - Math.abs(a.chg_7d_pct); })[0] : null;
      return (o.price_per_cu.krw_per_t_per_0_1pp_cu != null ? "Cu가 0.1%p 높으면 톤당 약 <b>" + won(Math.abs(o.price_per_cu.krw_per_t_per_0_1pp_cu)) + "원 " + (o.price_per_cu.krw_per_t_per_0_1pp_cu < 0 ? "싸요" : "비싸요") + "</b>" : "") +
        (big ? " · 7일 변동이 가장 큰 등급 " + esc(big.name) + " " + (big.chg_7d_pct > 0 ? "+" : "") + big.chg_7d_pct + "%" : "");
    }
    if (o.topic === "inventory") {
      var low = o.grades.filter(function (g) { return g.status === "부족"; }), used = o.grades.filter(function (g) { return g.today_at_limit; });
      return (low.length ? "부족: <b>" + low.map(function (g) { return esc(g.name) + "(" + g.cover_days + "일분)"; }).join(", ") + "</b>" : "부족한 등급 없음") + (used.length ? " · 오늘 재고 소진: " + used.map(function (g) { return esc(g.name); }).join(", ") : "");
    }
    if (o.topic === "notes_history") return o.source + " · 이상치 날짜(" + o.outlier_dates.join(", ") + ")의 메모 " + o.notes_on_outlier_dates.length + "건 · 키워드가 있지만 해결 문구가 붙은 메모 " + o.keyword_notes.with_resolution_words.length + "건";
    if (o.topic === "power") { var g2 = o.grades.slice().sort(function (a, b) { return b.kwh_per_t_charged - a.kwh_per_t_charged; });
      return "톤당 전력 최고 " + esc(g2[0].name) + " " + g2[0].kwh_per_t_charged + "kWh · 최저 " + esc(g2[g2.length - 1].name) + " " + g2[g2.length - 1].kwh_per_t_charged + "kWh"; }
    return "";
  }
  function mdLite(s) {    // AI 문장의 **굵게**, - 목록, 줄바꿈만 살린다
    var lines = esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").split(/\n+/), html = "", inList = false;
    lines.forEach(function (l) {
      var m = l.match(/^\s*[-•*]\s+(.*)/);
      if (m) { if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + m[1] + "</li>"; }
      else { if (inList) { html += "</ul>"; inList = false; } if (l.trim()) html += "<p>" + l + "</p>"; }
    });
    return html + (inList ? "</ul>" : "");
  }
  function marginChips(m) {
    return Object.keys(m || {}).map(function (s) { return '<span class="pill mute">' + esc(s) + " Cu " + (+m[s].cu).toFixed(3) + " · Sn " + (+m[s].sn).toFixed(4) + "%p</span>"; }).join(" ");
  }
  var ACT = { exclude: ["crit", "제외"], cap: ["warn", "5% 제한"], none: ["mute", "영향 없음"] };
  /* 메모 판정 이유 정리. TimelyGPT를 거친 실행에서 AI가 이유 칸에 'dummy'나 '수'의 역슬래시가 빠진 'uc218 uBD84'
     같은 글자를 넣은 적이 있다(10/3·10/8·10/24·10/30 통지서). 깨진 글자를 되살리면 오히려 엉뚱한 문장이 되어서,
     escape가 섞였거나 한글이 없으면 이유를 보여 주지 않는다. 통지서 5번 문단에 AI가 쓴 설명이 따로 있다. */
  function cleanReason(s) {
    s = String(s || "").trim();
    if (/(^|\s)\\?u[0-9a-fA-F]{4}/.test(s)) return "";
    return /[가-힣]/.test(s) ? s : "";
  }
  function rulesHtml(rules, notes) {
    if (!rules || !rules.length) return "";
    return '<ul class="rules-l">' + rules.map(function (r) {
      var n = (notes || []).filter(function (x) { return x.id === r.note_id; })[0], a = ACT[r.action] || ACT.none;
      return "<li>" + '<span class="pill ' + a[0] + '">' + a[1] + "</span> " + (n ? "“" + esc(n.text) + "”" : esc(r.note_id)) +
        (cleanReason(r.reason) ? ' <span class="muted">— ' + esc(cleanReason(r.reason)) + "</span>" : "") + "</li>";
    }).join("") + "</ul>";
  }
  function eventHtml(ev, notes) {
    if (ev.t === "thinking") return '<div class="ev-h"><span class="pill mute">🧠 생각</span></div><div class="ev-b think">' + mdLite(ev.text) + "</div>";
    if (ev.t === "text") return '<div class="ev-h"><span class="pill info">💬 AI</span></div><div class="ev-b">' + mdLite(ev.text) + "</div>";
    if (ev.t === "call") {
      var body = "";
      if (ev.name === "optimize_blend") body = '<div class="ev-sub">안전여유</div>' + marginChips(ev.input.margins) + (ev.input.note_rules && ev.input.note_rules.length ? '<div class="ev-sub">검수 메모 판정</div>' + rulesHtml(ev.input.note_rules, notes) : "");
      if (ev.name === "analyze_history") body = "주제: <b>" + esc(TOPIC_KO[ev.input.topic] || ev.input.topic) + "</b>";
      if (ev.name === "sensitivity") body = "변인: <b>" + esc(factorLabel(ev.input.factor, ev.input.change)) + "</b> · 대상: " + (ev.input.targets && ev.input.targets.length ? esc(ev.input.targets.map(function (g) { return gradeName(g); }).join(", ")) : "전체");
      if (ev.name === "write_report") body = "제목: <b>" + esc(ev.input.title || "") + "</b><br>" + esc(ev.input.summary || "");
      return '<div class="ev-h"><span class="pill point">🔧 도구 호출</span> <b>' + (TOOL_KO[ev.name] || esc(ev.name)) + '</b> <span class="mono muted">' + esc(ev.name) + "</span></div>" + (body ? '<div class="ev-b">' + body + "</div>" : "");
    }
    if (ev.t === "result") {
      var o = ev.out || {}, h = "";
      if (ev.name === "optimize_blend" && o.status === "duplicate") h = '<span class="pill mute">같은 조건</span> ' + esc(o.message);
      else if (ev.err || o.error || (ev.name === "optimize_blend" && o.status !== "ok")) h = '<span class="pill crit">실패</span> ' + esc(o.error || o.message || "") + (o.hint ? '<br><span class="muted">' + esc(o.hint) + "</span>" : "");
      else if (ev.name === "get_conditions") h = "등급 " + o.grades.length + "개 · 강종 " + o.steels.length + "개 · heat " + o.steels.reduce(function (a, t) { return a + t.heats; }, 0) + "개 · 검수 메모 " + o.notes.length + "건 · 목표 이탈 " + (o.target_fail_prob * 100) + "%" +
        (o.pass_criterion_p_fail && o.pass_criterion_p_fail !== o.target_fail_prob ? " (검증 기준 " + +(o.pass_criterion_p_fail * 100).toFixed(2) + "%)" : "") + "<br>" + '<div class="ev-sub">첫 안전여유 제안</div>' + marginChips(o.initial_margin_suggestion);
      else if (ev.name === "optimize_blend") h = "<b class=\"chem\">톤당 " + won(o.cost_per_t_krw) + "원</b> (" + o.iteration + "번째 계산)" +
        (o.excluded_grades.length ? ' · 제외 <b>' + esc(o.excluded_grades.join(", ")) + "</b>" : "") + (o.capped_grades.length ? " · 5% 제한 " + esc(o.capped_grades.join(", ")) : "") +
        '<div class="ev-sub">강종별 예상 성분</div>' + Object.keys(o.by_steel).map(function (s) { var v = o.by_steel[s]; return '<span class="pill mute">' + esc(s) + " Cu " + v.pred_cu_pct.toFixed(3) + "/" + v.cu_max_pct + "%</span>"; }).join(" ");
      else if (ev.name === "simulate_blend") h = (o.all_pass ? '<span class="pill good">✓ 모두 통과</span>' : '<span class="pill crit">기준 초과 있음</span>') + " 모의 조업 " + N_SIM.toLocaleString("ko-KR") + "회, " +
        (o.pass_criterion_pct != null && o.pass_criterion_pct !== o.target_p_fail_pct ? "검증 기준 " + +o.pass_criterion_pct.toFixed(2) + "% (목표 " + o.target_p_fail_pct + "%)" : "목표 " + o.target_p_fail_pct + "%") + "<br>" +
        Object.keys(o.by_steel).map(function (s) { var v = o.by_steel[s]; return '<span class="pill ' + (v.pass ? "good" : "crit") + '">' + esc(s) + " 최대 " + v.max_p_fail_pct.toFixed(1) + "% " + (v.pass ? "✓" : "✗") + "</span>"; }).join(" ");
      else if (ev.name === "analyze_history") h = historyBrief(o);
      else if (ev.name === "sensitivity") h = o.rows.slice(0, 4).map(function (x) {
          return '<span class="pill ' + (!x.feasible ? "crit" : x.delta_krw_per_t > 0 ? "warn" : x.delta_krw_per_t < 0 ? "good" : "mute") + '">' + esc(x.target) + " " +
            (x.feasible ? signed(x.delta_krw_per_t) + "원/t" + (x.max_p_fail_if_blend_fixed_pct != null ? " · 그대로면 이탈 " + x.max_p_fail_if_blend_fixed_pct + "%" : "") : "배합 불가") + "</span>"; }).join(" ") +
          (o.rows.length > 4 ? ' <span class="muted">외 ' + (o.rows.length - 4) + "건</span>" : "");
      else if (ev.name === "write_report") h = "통지서를 만들었어요. 아래 '배합 결정 통지서'에서 볼 수 있어요.";
      else if (o.note) h = esc(o.note);
      return '<div class="ev-h"><span class="pill ' + (ev.err || o.error ? "crit" : "good") + '">📊 결과</span> <span class="muted">' + (TOOL_KO[ev.name] || esc(ev.name)) + '</span></div><div class="ev-b">' + h + "</div>";
    }
    if (ev.t === "error") return '<div class="ev-h"><span class="pill crit">⚠ 멈춤</span></div><div class="ev-b">' + esc(ev.text) + "</div>";
    if (ev.t === "done") return '<div class="ev-h"><span class="pill good">✅ 완료</span></div><div class="ev-b">' + (ev.text ? mdLite(ev.text) : "배합을 정했어요. 아래 결과를 보세요.") + "</div>";
    return "";
  }
  function appendEvent(ev, i) {
    var li = document.createElement("li");
    li.className = "ev ev-" + ev.t + (ev.err ? " bad" : ""); li.dataset.i = i;
    li.innerHTML = eventHtml(ev, (run && run.spec.notes) || []);
    $("tl").appendChild(li);
    if (!presenting) li.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  }
  function showWaiting(on) { $("waiting").hidden = !on; }
  function setStatus(t, bad) { $("runStatus").textContent = t; $("runStatus").className = "status" + (bad ? " bad" : ""); }
  function drawUsage() {
    if (!run || run.mode !== "ai") { $("usage").textContent = run && run.mode === "plain" ? "AI 없이 계산 · API 비용 없음" : ""; return; }
    var u = run.usage, usd = u.in * PRICE_IN + u.cacheW * PRICE_IN * 1.25 + u.cacheR * PRICE_IN * 0.1 + u.out * PRICE_OUT;
    var tail = run.kind === "timely" ? " · TimelyGPT 크레딧에서 차감" : run.model === "claude-opus-5-5" ? " · 약 $" + usd.toFixed(3) : "";
    $("usage").textContent = (run.agentLabel ? run.agentLabel + " · " : "") + "토큰 입력 " + (u.in + u.cacheR + u.cacheW).toLocaleString("ko-KR") + " · 출력 " + u.out.toLocaleString("ko-KR") + tail;
  }

  /* 발표 모드: 끝난 실행을 한 단계씩 다시 보여 준다 */
  var presenting = false, pIdx = 0;
  function present(on) {
    if (!run) return;
    presenting = on; $("tl").classList.toggle("present", on); $("presentBtn").setAttribute("aria-pressed", on ? "true" : "false");
    $("tl").innerHTML = ""; run.events.forEach(function (ev, i) { appendEvent(ev, i); });
    pIdx = on ? 0 : run.events.length - 1; stepTo(pIdx);
  }
  function stepTo(i) {
    pIdx = Math.max(0, Math.min(i, run.events.length - 1));
    Array.prototype.forEach.call($("tl").children, function (li, k) { li.hidden = presenting && k > pIdx; li.classList.toggle("cur", presenting && k === pIdx); });
    $("stepNo").textContent = presenting ? (pIdx + 1) + " / " + run.events.length : run.events.length + "단계";
    var cur = $("tl").children[pIdx]; if (presenting && cur) cur.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }

  /* ====================================================================
     6. 결과 그리기
     ==================================================================== */
  function drawResult(r) {
    var L = r.last, su = r.su, ctx = su.ctx, o = L.opt;
    if (!L.sim) L.sim = E.simulate(ctx, o.x, su.comp, L.nc.mult, N_SIM, L.seed);
    var expert = E.canExpert(ctx, cfgFor()) ? E.expertBlend(ctx, su.comp, cfgFor()) : null;
    var maxH = L.sim.reduce(function (a, x) { return x.p_fail > a.p_fail ? x : a; }, L.sim[0]);
    var gate = gateOf(r.spec), pass = L.sim.every(function (x) { return x.p_fail <= gate; });
    var tap = o.heats.reduce(function (a, h) { return a + h.tap; }, 0);
    $("resBox").hidden = false;
    $("resMeta").textContent = (r.mode === "ai" ? "AI 에이전트 · " + (r.agentLabel || "Claude") : "AI 없이 (키워드 규칙)") + " · " + new Date(r.at).toLocaleString("ko-KR") + " · 최적화 " + r.optCalls + "회";
    $("resTiles").innerHTML = [
      ["톤당 배합 원가", won(o.costPerT) + "원", "하루 " + Math.round(tap).toLocaleString("ko-KR") + "t 출강 기준"],
      expert ? ["숙련자 배합 대비", "−" + won(expert.costPerT - o.costPerT) + "원/t", ((expert.costPerT - o.costPerT) / expert.costPerT * 100).toFixed(1) + "% 절감 · 숙련자 " + won(expert.costPerT) + "원"]
             : ["숙련자 배합 대비", "비교 없음", "등급 구성이 기본 8종과 달라 숙련자 배합표를 쓸 수 없어요"],
      ["예측 최대 이탈 확률", (maxH.p_fail * 100).toFixed(1) + "%", maxH.heat_id + " " + maxH.steel + " · 검증 기준 " + pct(gate) + "%(목표 " + pct(r.spec.target) + "%) " + (pass ? "통과" : "초과"), !pass],
      ["하루 배합 원가", (o.totalCost / 1e8).toFixed(2) + "억 원", ctx.plan.length + " heat 합계"]
    ].map(function (t) { return '<div class="tile' + (t[3] ? " alert" : "") + '"><span class="k">' + t[0] + '</span><span class="v">' + t[1] + '</span><span class="s">' + esc(t[2]) + "</span></div>"; }).join("");
    $("resConclusion").innerHTML = r.conclusion ? mdLite(r.conclusion) : '<p class="muted">설명이 없어요.</p>';
    $("resRules").innerHTML = r.spec.notes.length ? rulesHtml(L.rules, r.spec.notes) : '<p class="muted">검수 메모가 없었어요.</p>';
    $("resLegend").innerHTML = ctx.grades.map(function (g) { return '<span><i style="background:' + gradeColor(g) + '"></i>' + esc(gradeName(g)) + "</span>"; }).join("");
    $("resSteels").innerHTML = Object.keys(ctx.specs).map(function (s) {
      var hs = o.heats.filter(function (h) { return h.steel === s; }); if (!hs.length) return "";
      var sum = ctx.grades.map(function () { return 0; }), tot = 0;
      hs.forEach(function (h) { h.x.forEach(function (v, i) { sum[i] += v; tot += v; }); });
      var bar = '<div class="sbar">' + sum.map(function (v, i) { var p = v / tot * 100; return p > 0.05 ? '<i style="width:' + p + "%;background:" + gradeColor(ctx.grades[i]) + '" title="' + esc(gradeName(ctx.grades[i])) + " " + p.toFixed(1) + '%"></i>' : ""; }).join("") + "</div>";
      var cu = hs.reduce(function (a, h) { return a + h.predCu; }, 0) / hs.length, sn = hs.reduce(function (a, h) { return a + h.predSn; }, 0) / hs.length;
      var cps = hs.reduce(function (a, h) { return a + h.cost; }, 0) / hs.reduce(function (a, h) { return a + h.tap; }, 0);
      var pmax = Math.max.apply(null, L.sim.filter(function (x) { return x.steel === s; }).map(function (x) { return x.p_fail; })) * 100;
      return '<div class="steel"><div class="steel-h"><b>' + esc(s) + '</b><span class="muted">' + hs.length + " heat · 톤당 <b class=\"chem\">" + won(cps) + "원</b> · 예상 Cu <b class=\"chem\">" + cu.toFixed(3) + '%</b> <span class="lim">/ ' + ctx.specs[s].cu +
        "%</span> · Sn <b class=\"chem\">" + sn.toFixed(4) + '%</b> <span class="lim">/ ' + ctx.specs[s].sn + "%</span> · 최대 이탈 " + pmax.toFixed(1) + "% · 안전여유 Cu " + (+L.margins[s].cu).toFixed(3) + "%p</span></div>" + bar + "</div>";
    }).join("");
    var simd = {}; L.sim.forEach(function (x) { simd[x.heat_id] = x; });
    $("resHeats").innerHTML = o.heats.map(function (h) {
      var p = simd[h.heat_id].p_fail * 100;
      var mix = ctx.grades.map(function (g, i) { return h.x[i] > 0.05 ? esc(gradeName(g)) + " " + h.x[i].toFixed(1) + "t" : ""; }).filter(Boolean).join(", ");
      return '<tr><td class="mono"><b>' + h.heat_id + "</b></td><td>" + esc(h.steel) + '</td><td class="wrap">' + mix + '</td><td class="r">' + h.charge.toFixed(1) +
        '</td><td class="r"><b class="chem">' + h.predCu.toFixed(3) + '</b> <span class="lim">/ ' + h.cuMax + '</span></td><td class="r"><b class="chem">' + h.predSn.toFixed(4) + '</b> <span class="lim">/ ' + h.snMax +
        '</span></td><td class="r">' + (p > gate * 100 + 1e-9 ? '<span class="pill crit">' + p.toFixed(1) + "%</span>" : p.toFixed(1) + "%") + '</td><td class="r num">' + won(h.costPerT) + "</td></tr>";
    }).join("");
  }

  /* ====================================================================
     6-2. 배합 결정 통지서
     문장(요약·이유·변인 해석·위험·제안)은 AI가 write_report로 쓰고,
     숫자 표(배합, 재고 사용, 변인 영향, 검증 과정)는 도구 결과에서 화면이 직접 만든다.
     ==================================================================== */
  function docNo(r) { var t = new Date(r.at), p = function (v) { return (v < 10 ? "0" : "") + v; };
    return "RB-BLD-" + (r.bizDate || "").replace(/-/g, "") + "-" + p(t.getHours()) + p(t.getMinutes()); }
  function iterations(r) {      // 과정 기록에서 [최적화 → 검증] 쌍을 뽑는다
    var out = [], cur = null;
    r.events.forEach(function (ev) {
      if (ev.t === "call" && ev.name === "optimize_blend") cur = { margins: ev.input.margins };
      if (ev.t === "result" && ev.name === "optimize_blend" && cur && ev.out.status !== "duplicate" && !ev.out.error) { cur.ok = ev.out.status === "ok"; cur.cost = ev.out.cost_per_t_krw; out.push(cur); }
      if (ev.t === "result" && ev.name === "optimize_blend" && ev.out.status === "duplicate") cur = null;
      if (ev.t === "result" && ev.name === "simulate_blend" && out.length && !ev.out.error) {
        var c = out[out.length - 1]; c.pass = ev.out.all_pass;
        c.maxp = Math.max.apply(null, Object.keys(ev.out.by_steel).map(function (s) { return ev.out.by_steel[s].max_p_fail_pct; }));
      }
    });
    return out;
  }
  function sensChart(list) {
    var rows = [];
    list.forEach(function (s) { s.rows.forEach(function (x) { if (x.feasible) rows.push({ label: x.target + " " + factorLabel(s.factor, s.change), v: x.delta_krw_per_t, x: x }); }); });
    rows = rows.filter(function (x) { return x.v !== 0; }).sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); }).slice(0, 10);
    if (!rows.length) return '<p class="muted">원가를 바꾸는 변인이 없었어요.</p>';
    var mx = Math.max.apply(null, rows.map(function (x) { return Math.abs(x.v); }));
    return '<div class="tornado" role="img" aria-label="변인별 톤당 원가 변화">' + rows.map(function (x) {
      var w = Math.abs(x.v) / mx * 50, up = x.v > 0;
      var extra = x.x.max_p_fail_if_blend_fixed_pct != null ? " · 그대로면 이탈 " + x.x.max_p_fail_if_blend_fixed_pct + "%" : x.x.delta_if_blend_fixed_krw_per_t != null && x.x.delta_if_blend_fixed_krw_per_t !== x.v ? " · 그대로면 " + signed(x.x.delta_if_blend_fixed_krw_per_t) : "";
      return '<div class="tr"><span class="tl-l">' + esc(x.label) + '</span><span class="tl-bar"><i class="' + (up ? "up" : "dn") + '" style="width:' + w + "%;" + (up ? "left:50%" : "right:50%") + '"></i></span>' +
        '<span class="tl-v">' + signed(x.v) + '원/t<small>' + esc(extra) + "</small></span></div>";
    }).join("") + '</div><p class="muted fine-note">막대: 변인 하나만 바꿔 다시 최적화했을 때 톤당 원가 변화. 주황은 오르고, 초록은 내려가요. 안전여유와 메모 판정은 그대로 뒀어요.</p>';
  }
  function drawReport(r) {
    var R = r.report, L = r.last; if (!R || !L) { $("reportBox").hidden = true; return; }
    var su = r.su, ctx = su.ctx, o = L.opt, nm = function (g) { return gradeName(g, r.spec); };
    if (!L.sim) L.sim = E.simulate(ctx, o.x, su.comp, L.nc.mult, N_SIM, L.seed);
    var bd = A.binding(ctx, o, L.margins), u = P.me();
    var expert = E.canExpert(ctx, cfgFor()) ? E.expertBlend(ctx, su.comp, cfgFor()) : null;
    var mp = Math.max.apply(null, L.sim.map(function (x) { return x.p_fail; })) * 100;
    var calls = r.events.filter(function (e) { return e.t === "call"; }).length;
    var steelsHtml = Object.keys(ctx.specs).map(function (s) {
      var hs = o.heats.filter(function (h) { return h.steel === s; }); if (!hs.length) return "";
      var sum = ctx.grades.map(function () { return 0; }), tot = 0;
      hs.forEach(function (h) { h.x.forEach(function (v, i) { sum[i] += v; tot += v; }); });
      var mix = sum.map(function (v, i) { return { g: ctx.grades[i], p: v / tot * 100 }; }).filter(function (x) { return x.p >= 0.5; }).sort(function (a, b) { return b.p - a.p; })
        .map(function (x) { return esc(nm(x.g)) + " " + x.p.toFixed(0) + "%"; }).join(", ");
      var cu = hs.reduce(function (a, h) { return a + h.predCu; }, 0) / hs.length, sn = hs.reduce(function (a, h) { return a + h.predSn; }, 0) / hs.length;
      var cps = hs.reduce(function (a, h) { return a + h.cost; }, 0) / hs.reduce(function (a, h) { return a + h.tap; }, 0);
      var pm = Math.max.apply(null, L.sim.filter(function (x) { return x.steel === s; }).map(function (x) { return x.p_fail; })) * 100;
      return "<tr><td><b>" + esc(s) + "</b></td><td class=\"r\">" + hs.length + '</td><td class="wrap">' + mix + '</td><td class="r">' + cu.toFixed(3) + ' <span class="lim">/ ' + ctx.specs[s].cu + '</span></td><td class="r">' + sn.toFixed(4) + ' <span class="lim">/ ' + ctx.specs[s].sn +
        '</span></td><td class="r">' + pm.toFixed(1) + "%</td><td>" + esc(bd.steel[s].limiting) + '</td><td class="r num">' + won(cps) + "</td></tr>";
    }).join("");
    var gradesHtml = ctx.grades.map(function (g, i) {
      var used = bd.usage[g], tag = L.nc.exclude.indexOf(g) >= 0 ? '<span class="pill crit">메모로 제외</span>' : L.nc.cap[g] ? '<span class="pill warn">5% 제한</span>' :
        bd.inventoryLimited.indexOf(g) >= 0 ? '<span class="pill point">재고 소진</span>' : used < 0.5 ? '<span class="pill mute">미사용</span>' : "";
      return "<tr><td>" + esc(nm(g)) + '</td><td class="r num">' + won(ctx.price[i]) + '</td><td class="r">' + r4(su.comp.grades[g].cu_mean).toFixed(3) + '</td><td class="r">' + Math.round(used).toLocaleString("ko-KR") +
        '</td><td class="r">' + Math.round(ctx.inv[i]).toLocaleString("ko-KR") + "</td><td>" + tag + "</td></tr>";
    }).join("");
    var its = iterations(r);
    var srcs = r.topics.map(function (t) { return TOPIC_KO[t]; });
    $("reportBox").hidden = false;
    $("report").innerHTML =
      '<header class="doc-h"><div class="doc-no">문서번호 ' + docNo(r) + '</div><h2>배합 결정 통지서</h2><p class="doc-title">' + esc(R.title) + "</p>" +
      '<dl class="doc-kv"><dt>수신</dt><dd>제강팀장 박준영</dd><dt>참조</dt><dd>생산본부장 정민재, 품질보증팀, 구매팀</dd>' +
      "<dt>작성</dt><dd>" + esc(u.name) + " (제강팀 스크랩 배합 담당)</dd><dt>업무 기준일</dt><dd>" + esc(r.bizDate || "") + (r.spec.date && r.spec.date !== r.bizDate ? " · 조건은 " + esc(r.spec.date) + " 기준" : "") + "</dd>" +
      "<dt>작성 방식</dt><dd>" + (R.by !== "규칙" ? "AI 에이전트 · " + esc(r.agentLabel || "Claude") + " (도구 " + calls + "회 호출)" : R.fallback ? "규칙 기반 자동 작성 (AI가 통지서를 쓰지 않아 대신 채움)" : "규칙 기반 자동 작성 (AI 없이 계산)") + "</dd></dl></header>" +

      '<section><h3>1. 요약</h3><p>' + esc(R.summary) + '</p><div class="doc-kpi">' +
        "<div><span>톤당 배합 원가</span><b>" + won(o.costPerT) + "원</b></div>" +
        "<div><span>숙련자 배합 대비</span><b>" + (expert ? "−" + won(expert.costPerT - o.costPerT) + "원/t" : "비교 없음") + "</b></div>" +
        "<div><span>최대 이탈 확률</span><b>" + mp.toFixed(1) + "% <small>기준 " + pct(gateOf(r.spec)) + "% · 목표 " + pct(r.spec.target) + "%</small></b></div>" +
        "<div><span>하루 배합 원가</span><b>" + (o.totalCost / 1e8).toFixed(2) + "억 원</b></div></div></section>" +

      "<section><h3>2. 결정한 배합</h3>" +
        '<div class="scroll-x"><table><thead><tr><th>강종</th><th class="r">heat</th><th>배합 비율</th><th class="r">예상 Cu % / 상한</th><th class="r">예상 Sn % / 상한</th><th class="r">최대 이탈</th><th>묶는 제약</th><th class="r">원/t</th></tr></thead><tbody>' + steelsHtml + "</tbody></table></div>" +
        '<div class="scroll-x"><table><thead><tr><th>등급</th><th class="r">단가(원/t)</th><th class="r">Cu % (추정)</th><th class="r">사용 t</th><th class="r">재고 t</th><th>비고</th></tr></thead><tbody>' + gradesHtml + "</tbody></table></div></section>" +

      "<section><h3>3. 이렇게 정한 이유</h3><ol>" + R.reasons.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ol></section>" +

      "<section><h3>4. 기록 분석과 변인 영향</h3>" +
        (R.factors.length ? '<div class="scroll-x"><table><thead><tr><th>변인</th><th>분석에서 본 것</th><th>배합에 미친 영향</th></tr></thead><tbody>' +
          R.factors.map(function (f) { return "<tr><td><b>" + esc(f.factor) + '</b></td><td class="wrap">' + esc(f.finding) + '</td><td class="wrap">' + esc(f.effect) + "</td></tr>"; }).join("") + "</tbody></table></div>" : "") +
        (r.sens.length ? "<h4>변인 하나씩 바꿔 본 결과</h4>" + sensChart(r.sens) : "") + "</section>" +

      "<section><h3>5. 검수 메모 판정</h3><p>" + esc(R.notesSummary) + "</p>" + rulesHtml(L.rules, r.spec.notes) + "</section>" +

      "<section><h3>6. 위험과 대응</h3>" + (R.risks.length ? '<div class="scroll-x"><table><thead><tr><th>위험</th><th>대응</th></tr></thead><tbody>' +
        R.risks.map(function (x) { return '<tr><td class="wrap">' + esc(x.risk) + '</td><td class="wrap">' + esc(x.action) + "</td></tr>"; }).join("") + "</tbody></table></div>" : '<p class="muted">없음</p>') + "</section>" +

      "<section><h3>7. 제안</h3><ul>" + R.recs.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></section>" +

      "<section><h3>8. 검증 과정과 근거 자료</h3>" +
        '<div class="scroll-x"><table><thead><tr><th class="r">회차</th><th>안전여유 (Cu, %p)</th><th class="r">톤당 원가</th><th class="r">최대 이탈</th><th>판정</th></tr></thead><tbody>' +
        its.map(function (x, i) { return '<tr><td class="r">' + (i + 1) + "</td><td>" + Object.keys(x.margins || {}).map(function (s) { return esc(s) + " " + (+x.margins[s].cu).toFixed(3); }).join(" · ") +
          '</td><td class="r num">' + (x.ok ? won(x.cost) + "원" : "배합 불가") + '</td><td class="r">' + (x.maxp != null ? x.maxp.toFixed(1) + "%" : "-") + "</td><td>" + (x.pass ? '<span class="pill good">통과</span>' : x.ok ? (x.maxp != null ? '<span class="pill crit">초과</span>' : "-") : '<span class="pill crit">불가</span>') + "</td></tr>"; }).join("") +
        "</tbody></table></div>" +
        '<p class="fine-note">근거 자료: 오늘 입력 조건' + (srcs.length ? ", " + srcs.join(", ") : "") + " (과거 조업 이력 " + C.heats.rows.length + " heat, 시세·재고 기록, 검수 메모). 숫자는 계산 도구(선형계획법, 모의 조업 " + N_SIM.toLocaleString("ko-KR") + "회)의 결과이고, " +
        (R.by !== "규칙" ? "문장은 AI(" + esc(r.agentLabel || "Claude") + ")가 그 결과를 읽고 썼어요." : "문장은 정해진 틀에 숫자를 채운 거예요.") + " 최종 결정은 결재권자가 해요.</p></section>";
    $("noticeState").textContent = sentNotice(r) ? "메일함에 통지한 통지서예요." : "";
  }
  // 통지한 배합을 '오늘의 조업 현황'이 그대로 읽을 수 있는 모양(자동 초안과 같은 구조)으로 만든다
  function noticeSheet(r, expert) {
    var L = r.last, su = r.su, ctx = su.ctx, o = L.opt, nm = function (g) { return gradeName(g, r.spec); };
    if (!L.sim) L.sim = E.simulate(ctx, o.x, su.comp, L.nc.mult, N_SIM, L.seed);
    var simd = {}; L.sim.forEach(function (x) { simd[x.heat_id] = x; });
    var bd = A.binding(ctx, o, L.margins), r1 = function (v) { return Math.round(v * 10) / 10; };
    var heats = o.heats.map(function (h) {
      var lim = bd.steel[h.steel] ? bd.steel[h.steel].limiting : "";
      return { heat_id: h.heat_id, steel_grade: h.steel, target_tap_t: r1(h.W), charge_t: h.charge, volume_m3: h.vol,
        pred_cu_pct: h.predCu, cu_max_pct: h.cuMax, pred_sn_pct: h.predSn, sn_max_pct: h.snMax,
        p_fail_pct: simd[h.heat_id].p_fail * 100, cost_per_t: h.costPerT,
        charges: ctx.grades.map(function (g, i) { return { grade_id: g, name_kr: nm(g), t: r1(h.x[i]), pct: r1(h.x[i] / h.charge * 100) }; }).filter(function (c) { return c.t >= 0.1; }),
        rationale: "AI 배합 설계 통지서(" + docNo(r) + ") 기준. " + h.steel + " 안전여유 Cu " + (+L.margins[h.steel].cu).toFixed(3) + "%p" + (lim && lim !== "없음" ? ", " + lim + " 상한에 맞춰 싼 등급을 최대한 사용" : "") + "." };
    });
    var by = {};
    Object.keys(ctx.specs).forEach(function (s) {
      var hs = heats.filter(function (h) { return h.steel_grade === s; }); if (!hs.length) return;
      var oh = o.heats.filter(function (h) { return h.steel === s; });
      by[s] = { pred_cu_pct: hs.reduce(function (a, h) { return a + h.pred_cu_pct; }, 0) / hs.length, cu_max_pct: ctx.specs[s].cu,
        pred_sn_pct: hs.reduce(function (a, h) { return a + h.pred_sn_pct; }, 0) / hs.length, sn_max_pct: ctx.specs[s].sn,
        cost_per_t: oh.reduce(function (a, h) { return a + h.cost; }, 0) / oh.reduce(function (a, h) { return a + h.tap; }, 0),
        margin_cu_pct: +L.margins[s].cu, max_p_fail_pct: Math.max.apply(null, hs.map(function (h) { return h.p_fail_pct; })) };
    });
    var its = iterations(r);
    return {
      date: r.bizDate, source: { docNo: docNo(r), by: r.report.by === "규칙" ? "규칙" : (r.agentLabel || "Claude"), at: r.at },
      summary: { cost_per_t: o.costPerT, expert_cost_per_t: expert ? expert.costPerT : o.costPerT, saving_per_t: expert ? expert.costPerT - o.costPerT : 0, iterations: its.length, by_steel: by },
      heats: heats,
      flags: L.flags.map(function (f) { return { lot_id: nm(f.grade_id) + " 메모 " + f.lot_id, grade_id: f.grade_id, risk: f.risk, element: f.element, suspected_multiplier: f.suspected_multiplier, reason: f.reason }; }),
      notes: r.spec.notes.map(function (n) { return { lot_id: n.id, grade_id: n.grade, note_text: n.text }; }),
      rationale: { day_summary: r.report.summary, method: r.report.by === "규칙" ? "template" : "llm" },
      log: its.map(function (x, i) { return (i + 1) + "회차: 안전여유 Cu " + Object.keys(x.margins || {}).map(function (s) { return s + " " + (+x.margins[s].cu).toFixed(3); }).join(" · ") + "%p → " +
        (x.ok ? "톤당 " + won(x.cost) + "원" + (x.maxp != null ? ", 최대 이탈 " + x.maxp.toFixed(1) + "% " + (x.pass ? "통과" : "초과") : "") : "배합 불가"); })
    };
  }
  function sentNotice(r) { return P.store.get("rb-notices", []).some(function (n) { return n.id === r.at; }); }
  function sendNotice() {
    var r = run; if (!r || !r.report || !r.last) return;
    if (sentNotice(r)) { $("noticeState").innerHTML = '이미 통지했어요. <a href="mail.html">메일함 보기</a>'; return; }
    var L = r.last, su = r.su, ctx = su.ctx, o = L.opt;
    var expert = E.canExpert(ctx, cfgFor()) ? E.expertBlend(ctx, su.comp, cfgFor()) : null;
    var now = new Date(), hh = (now.getHours() < 10 ? "0" : "") + now.getHours() + ":" + (now.getMinutes() < 10 ? "0" : "") + now.getMinutes();
    var all = P.store.get("rb-notices", []);
    all.unshift({ id: r.at, date: r.bizDate, time: hh, title: r.report.title, summary: r.report.summary, by: r.report.by === "규칙" ? "규칙" : (r.agentLabel || "Claude"), docNo: docNo(r),
      costPerT: Math.round(o.costPerT), saving: expert ? Math.round(expert.costPerT - o.costPerT) : null,
      maxP: Math.round(Math.max.apply(null, L.sim.map(function (x) { return x.p_fail; })) * 1000) / 10, reasons: r.report.reasons.slice(0, 4),
      sheet: noticeSheet(r, expert) });
    P.store.set("rb-notices", all.slice(0, 20));
    P.refresh();
    $("noticeState").innerHTML = '박준영 팀장님께 통지했어요. <a href="mail.html">메일함에서 보기</a> · <a href="ops.html?date=' + r.bizDate + '">오늘의 조업 현황에 반영됨 →</a>';
  }

  /* ====================================================================
     7. 실행 기록 저장·불러오기 (이 브라우저, 최근 8건)
     ==================================================================== */
  function saveRun(r) {
    var rec = { at: r.at, bizDate: r.bizDate, mode: r.mode, kind: r.kind, model: r.model, agentLabel: r.agentLabel, spec: r.spec, events: r.events, usage: r.usage, conclusion: r.conclusion, optCalls: r.optCalls, status: r.status,
                last: r.last ? { margins: r.last.margins, rules: r.last.rules, seed: r.last.seed } : null,
                sens: r.sens, topics: r.topics, report: r.report,
                cost: r.last ? Math.round(r.last.opt.costPerT) : null };
    var all = P.store.get(RUNS_KEY, []).filter(function (x) { return x.at !== rec.at; }); all.unshift(rec); P.store.set(RUNS_KEY, all.slice(0, 8));
  }
  function loadRun(rec) {
    var su = E.customSetup(engineSpec(rec.spec));
    var r = { mode: rec.mode, kind: rec.kind, model: rec.model, agentLabel: rec.agentLabel, at: rec.at, bizDate: rec.bizDate, spec: rec.spec, su: su, events: rec.events, usage: rec.usage, conclusion: rec.conclusion, optCalls: rec.optCalls, status: rec.status, last: null,
              sens: rec.sens || [], topics: rec.topics || [], report: rec.report || null };
    if (rec.last) {
      run = r;   // rulesToNc는 run.spec을 본다
      var conv = rulesToNc(rec.last.rules), o = E.optimize(su.ctx, su.comp, rec.last.margins, conv.nc, window.solver);
      if (o.status === "ok") r.last = { opt: o, margins: rec.last.margins, rules: rec.last.rules, flags: conv.flags, nc: conv.nc, sim: null, seed: rec.last.seed };
    }
    run = r;
    $("tlBox").hidden = false; $("replayBar").hidden = false;
    presenting = false; $("tl").classList.remove("present"); $("tl").innerHTML = "";
    r.events.forEach(function (ev, i) { appendEvent(ev, i); });
    stepTo(r.events.length - 1); drawUsage();
    if (r.last) { drawResult(r); drawReport(r); } else { $("resBox").hidden = true; $("reportBox").hidden = true; }
    setStatus("저장된 실행을 불러왔어요. '발표 모드'로 한 단계씩 다시 볼 수 있어요.");
  }
  function drawSaved() {
    var all = P.store.get(RUNS_KEY, []);
    $("savedRuns").innerHTML = '<option value="">최근 실행 다시 보기…</option>' + all.map(function (r, i) {
      return '<option value="' + i + '">' + new Date(r.at).toLocaleString("ko-KR") + " · " + (r.mode === "ai" ? (r.agentLabel || "Claude") : "AI 없이") + (r.cost ? " · " + won(r.cost) + "원/t" : " · 미완료") + "</option>";
    }).join("");
  }

  /* ====================================================================
     8. API 키 다루기: 저장소·코드에 넣지 않고, 원하면 이 창에만 기억
     ==================================================================== */
  function rememberKey(k) {
    try { if ($("rememberKey").checked) sessionStorage.setItem("rb-claude-key", k); else sessionStorage.removeItem("rb-claude-key"); } catch (e) { /* 창 메모리만 */ }
  }
  function restoreKey() { try { var k = sessionStorage.getItem("rb-claude-key"); if (k) { $("apiKey").value = k; $("rememberKey").checked = true; } } catch (e) { /* 무시 */ } }

  /* ====================================================================
     9. 연결
     ==================================================================== */
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function bind() {
    $("addGrade").addEventListener("click", function () {
      if (spec.grades.length >= LIMITS.grades) return;
      while (spec.grades.some(function (g) { return g.id === "G" + nextId; })) nextId++;
      spec.grades.push({ id: "G" + nextId++, name: "새 등급", price: 350000, inv: 300, y: 0.9, dens: 0.8, cu: 0.2, cuSd: 0.05, sn: 0.015, snSd: 0.004 });
      changed(true);
    });
    $("addSteel").addEventListener("click", function () { spec.steels.push({ steel: "SD" + (400 + spec.steels.length * 100), cu: 0.35, sn: 0.035, heats: 2, W: 100 }); changed(true); });
    $("addNote").addEventListener("click", function () {
      if (!spec.grades.length) return;
      var id = 1; while (spec.notes.some(function (n) { return n.id === "N" + id; })) id++;
      spec.notes.push({ id: "N" + id, grade: spec.grades[0].id, text: "" }); changed(true);
      var inp = $("noteRows").querySelector("li:last-child input"); if (inp) inp.focus();
    });
    $("target").addEventListener("change", function () { spec.target = +$("target").value; changed(false); });
    $("vol").addEventListener("change", function () { spec.vol = +$("vol").value; changed(false); });
    $("loadBtn").addEventListener("click", function () {
      var d = $("loadDate").value; spec = specFromDate(d); specDate = d; dirty = false;
      $("loadNote").textContent = d + " (" + P.dow(d) + ") 조건을 불러왔어요. 자유롭게 고쳐서 풀어 보세요.";
      drawAll();
    });
    $("aiBtn").addEventListener("click", function () { if (!busy && !showErrors().length) runAgent(); });
    $("plainBtn").addEventListener("click", function () { if (!busy && !showErrors().length) runPlain(); });
    $("presentBtn").addEventListener("click", function () { present(!presenting); });
    $("printBtn").addEventListener("click", function () { window.print(); });
    $("modelsBtn").addEventListener("click", loadModels);
    var lastKind = null;
    $("apiKey").addEventListener("input", function () { var k = keyKind(apiKey()); if (k && k !== lastKind) { lastKind = k; drawModelOptions(); } });
    $("model").addEventListener("change", function () { P.store.set("rb-model", $("model").value); });
    $("noticeBtn").addEventListener("click", sendNotice);
    $("prevBtn").addEventListener("click", function () { if (presenting) stepTo(pIdx - 1); });
    $("nextBtn").addEventListener("click", function () { if (!presenting) present(true); else stepTo(pIdx + 1); });
    $("savedRuns").addEventListener("change", function () {
      var i = $("savedRuns").value; if (i === "") return;
      var rec = P.store.get(RUNS_KEY, [])[+i]; if (rec) loadRun(rec);
      $("savedRuns").value = "";
    });
    document.addEventListener("keydown", function (e) {
      if (!presenting || /input|select|textarea/i.test((e.target.tagName || ""))) return;
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); stepTo(pIdx + 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); stepTo(pIdx - 1); }
    });
    $("loadDate").innerHTML = P.DATES.map(function (d) { return '<option value="' + d + '">' + d + " (" + P.dow(d) + ")</option>"; }).join("");
    restoreKey(); drawModelOptions(); lastKind = keyKind(apiKey()); drawSaved();
  }

  var bound = false;
  function render(c) {
    if (!bound) { bind(); bound = true; }
    if (!spec || !dirty) {           // 아직 손대지 않았으면 업무 기준일의 조건으로 시작
      spec = specFromDate(c.date); specDate = c.date;
      $("loadDate").value = c.date;
      $("loadNote").textContent = c.date + " (" + P.dow(c.date) + ") 조건을 불러왔어요. 자유롭게 고쳐서 풀어 보세요.";
      drawAll();
    }
    curDate = c.date;
    var want = P.params.get("run");      // 메일의 '통지서 전문 보기' 링크
    if (want && !openedFromLink) {
      openedFromLink = true;
      var rec = P.store.get(RUNS_KEY, []).filter(function (x) { return x.at === want; })[0];
      if (rec) { loadRun(rec); $("reportBox").scrollIntoView({ block: "start" }); }
      else setStatus("그 통지서의 실행 기록이 이 브라우저에 더 이상 없어요 (최근 8건만 보관).", true);
    }
  }
  var openedFromLink = false;
  window.ReBornDesigner = { tools: TOOLS_IMPL, getRun: function () { return run; } };   // 시험용
  P.start(render);
})();
