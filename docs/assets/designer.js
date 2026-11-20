/* AI 배합 설계 (agent.html)
   사용자가 조건(스크랩 등급·가격·재고·성분, 강종 상한·heat 수, 검수 메모)을 넣으면
   Claude 에이전트가 도구를 골라 쓰며 가장 싸고 규격을 지키는 배합을 직접 풀어 낸다.
   - 계산(선형계획, 모의 조업)은 engine.js가 이 브라우저에서 한다. Claude는 숫자를 만들지 않는다.
   - Claude가 하는 일: 조건 읽기, 검수 메모 해석(제외/5% 제한/영향 없음), 안전여유 결정과 재계산 판단, 결과 설명.
   - API 키는 사용자가 넣는다. 코드나 저장소에 넣지 않고, 원하면 이 창(sessionStorage)에만 둔다.
   - 키가 없으면 같은 계산을 키워드 규칙으로 돌린다("AI 없이 계산").
   - 실행 기록(과정·결과)은 이 브라우저에 최근 5건 저장해, 발표 모드에서 한 단계씩 다시 볼 수 있다. */
(function () {
  "use strict";
  var P = window.Portal, E = window.RebornEngine;
  if (!P || !P.D || !E) return;
  var $ = P.$, esc = P.esc, C = P.C, won = P.won;
  var MODEL = "claude-opus-5-5";
  var PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6;           // 달러/토큰 (Claude Opus 5.5)
  var MAX_TURNS = 20, MAX_OPT = Math.max(8, C.config.max_iterations), N_SIM = C.config.n_sim;
  var LIMITS = { grades: 15, heats: 48 };
  var PALETTE = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
  var RUNS_KEY = "rb-design-runs";

  /* ====================================================================
     1. 조건 (spec): 화면 입력과 1:1로 대응하는 상태
     ==================================================================== */
  var spec = null, specDate = null, dirty = false;
  var nextId = 1;

  function specFromDate(d) {
    var mk = C.market[d], est = C.estimate.grades, byId = {};
    C.scrap.forEach(function (s) { byId[s.grade_id] = s; });
    var cnt = {}; C.plan.forEach(function (p) { cnt[p.steel_grade] = (cnt[p.steel_grade] || 0) + 1; });
    return {
      grades: C.config.grades.map(function (g) {
        return { id: g, name: byId[g].name_kr, price: mk[g][0], inv: mk[g][1], y: byId[g].yield, dens: byId[g].bulk_density_t_per_m3,
                 cu: r4(est[g].cu_mean), cuSd: r4(est[g].cu_sd), sn: r5(est[g].sn_mean), snSd: r5(est[g].sn_sd) };
      }),
      steels: C.specs.map(function (s) { return { steel: s.steel_grade, cu: s.cu_max_pct, sn: s.sn_max_pct, heats: cnt[s.steel_grade] || 0, W: 100 }; }),
      notes: C.notes.filter(function (n) { return n.date === d; }).map(function (n, i) { return { id: "N" + (i + 1), grade: n.grade_id, text: n.note_text }; }),
      target: 0.02, vol: C.config.max_charge_volume_m3, measSd: C.estimate.meas_sd
    };
  }
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
          num(g.cuSd, 0.001).replace("<input", '<input data-k="cuSd" aria-label="Cu 편차" style="width:72px"') + "</td>" +
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
    var su = E.customSetup(engineSpec(s));
    return { mode: mode, at: new Date().toISOString(), spec: s, su: su, events: [], optCalls: 0,
             last: null, usage: { in: 0, out: 0, cacheR: 0, cacheW: 0 }, conclusion: "", status: "running" };
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
          cu_mean_pct: g.cu, cu_sd_pct: g.cuSd, sn_mean_pct: g.sn, sn_sd_pct: g.snSd }; }),
        steels: engineSpec(s).steels.map(function (t) { return { steel: t.steel, cu_max_pct: t.cu, sn_max_pct: t.sn, heats: t.heats, tap_t_per_heat: t.W }; }),
        bucket_volume_m3: s.vol, target_fail_prob: s.target,
        notes: s.notes.map(function (n) { return { note_id: n.id, grade_id: n.grade, grade_name: gradeName(n.grade), text: n.text }; }),
        initial_margin_suggestion: E.initialMargins(su.ctx, su.comp, cfgFor(), s.target),
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
      var o = E.optimize(su.ctx, su.comp, mg, conv.nc, window.solver);
      run.optCalls++;
      if (o.status !== "ok") return { status: "infeasible", iteration: run.optCalls, message: o.message,
        hint: "안전여유를 줄이거나, 제외한 등급을 다시 보거나, 재고·버킷 용적 조건을 확인하세요." };
      run.last = { opt: o, margins: mg, rules: input.note_rules || [], flags: conv.flags, nc: conv.nc, sim: null, seed: run.optCalls };
      var by = {};
      Object.keys(su.ctx.specs).forEach(function (st) {
        var hs = o.heats.filter(function (h) { return h.steel === st; });
        if (!hs.length) return;
        by[st] = { heats: hs.length, share_pct: steelShares(o, su.ctx, st),
          pred_cu_pct: r4(hs.reduce(function (a, h) { return a + h.predCu; }, 0) / hs.length), cu_max_pct: su.ctx.specs[st].cu,
          pred_sn_pct: r5(hs.reduce(function (a, h) { return a + h.predSn; }, 0) / hs.length), sn_max_pct: su.ctx.specs[st].sn,
          max_volume_m3: Math.round(Math.max.apply(null, hs.map(function (h) { return h.vol; })) * 10) / 10 };
      });
      return { status: "ok", iteration: run.optCalls, cost_per_t_krw: Math.round(o.costPerT), total_cost_krw: Math.round(o.totalCost),
               excluded_grades: conv.nc.exclude.map(function (g) { return gradeName(g); }),
               capped_grades: Object.keys(conv.nc.cap).map(function (g) { return gradeName(g); }), by_steel: by };
    },
    simulate_blend: function () {
      if (!run.last) return { error: "먼저 optimize_blend로 배합을 계산하세요." };
      var su = run.su, L = run.last;
      L.sim = E.simulate(su.ctx, L.opt.x, su.comp, L.nc.mult, N_SIM, L.seed);
      var sg = E.suggestMargins(L.sim, su.ctx, L.margins, run.spec.target), by = {};
      Object.keys(sg.status).forEach(function (st) {
        var rows = L.sim.filter(function (r) { return r.steel === st; });
        var w = rows.reduce(function (a, r) { return r.p_fail > a.p_fail ? r : a; }, rows[0]);
        by[st] = { max_p_fail_pct: Math.round(w.p_fail * 1000) / 10, worst_heat: w.heat_id, pass: sg.status[st].pass,
          max_p_fail_cu_pct: Math.round(Math.max.apply(null, rows.map(function (r) { return r.p_fail_cu; })) * 1000) / 10,
          max_p_fail_sn_pct: Math.round(Math.max.apply(null, rows.map(function (r) { return r.p_fail_sn; })) * 1000) / 10 };
      });
      var pass = Object.keys(sg.status).every(function (st) { return sg.status[st].pass; });
      L.pass = pass;
      return { simulations: N_SIM, target_p_fail_pct: run.spec.target * 100, all_pass: pass, by_steel: by, current_margins: L.margins, suggested_margins: sg.next };
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
                  element: { type: "string", enum: ["cu", "sn", "none"] }, multiplier: { type: "number" }, reason: { type: "string" } } } } } } },
      { name: "simulate_blend", strict: true,
        description: "가장 최근 optimize_blend 배합으로 몬테카를로 모의 조업을 " + N_SIM + "회 돌려 heat별 규격 이탈 확률을 계산한다. 목표를 넘은 강종에는 안전여유 조정 제안값을 준다.",
        input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }
    ];
  }
  function systemPrompt() {
    return "당신은 전기로 제강사 리본스틸(가상 기업)의 스크랩 배합 AI 에이전트입니다.\n" +
      "목표: 주어진 조건에서 모든 heat의 규격 이탈 확률을 목표 이하로 지키면서 톤당 배합 원가가 가장 낮은 스크랩 배합을 찾습니다.\n\n" +
      "작업 순서\n" +
      "1. get_conditions로 조건을 읽습니다.\n" +
      "2. 검수 메모를 하나씩 판단합니다. Cu·Sn 원천(모터, 전선, 구리코일, 황동, 주석도금 캔, 비철 선별 불량 등)이 실제로 섞였다고 적혀 있으면 exclude, " +
      "가능성만 언급되면 cap, 성분과 무관하거나(유분·수분·녹·부피) '제거 완료', '분석 결과 정상'처럼 이미 해결됐다고 적혀 있으면 none입니다.\n" +
      "3. 제안된 첫 안전여유와 메모 판정으로 optimize_blend를 부르고, 바로 simulate_blend로 검증합니다.\n" +
      "4. 목표를 넘는 강종이 있으면 그 강종의 안전여유만 키워 다시 최적화합니다. suggested_margins를 참고하되 판단은 직접 하세요. 통과한 강종의 여유를 괜히 키우면 원가가 오릅니다.\n" +
      "5. 최적화는 최대 " + MAX_OPT + "번입니다. 배합이 불가능하다고 나오면 원인을 짐작해 여유를 줄이는 등 조정합니다.\n" +
      "6. 모든 강종이 통과하면 도구 호출을 멈추고, 한국어로 결과를 설명합니다: 메모를 어떻게 판단했는지, 안전여유를 어떻게 바꿨는지, 최종 톤당 원가와 이탈 확률, 배합의 특징(어떤 등급을 많이·적게 썼는지). 5~7문장, 담당자에게 말하듯 자연스럽게.\n\n" +
      "규칙: 숫자는 도구 결과에 있는 값만 쓰고 지어내지 마세요. 도구를 부르기 전에 무엇을 하려는지 한두 문장으로 짧게 말해 주세요.";
  }

  /* ====================================================================
     4. 실행: Claude 에이전트 / AI 없이
     ==================================================================== */
  var busy = false;
  function emit(ev) { run.events.push(ev); if (!presenting) appendEvent(ev, run.events.length - 1); }

  function getSdk() {
    if (window.Anthropic) return Promise.resolve(window.Anthropic);
    return new Promise(function (ok, fail) {
      var t = setTimeout(function () { fail(new Error("Claude SDK를 불러오지 못했어요. 인터넷 연결을 확인하세요.")); }, 15000);
      window.addEventListener("anthropic-ready", function () { clearTimeout(t); ok(window.Anthropic); }, { once: true });
    });
  }
  function apiKey() { var k = $("apiKey").value.trim(); return k; }

  async function runAgent() {
    var key = apiKey();
    if (/[^\x21-\x7e]/.test(key)) { setStatus("API 키에 공백이나 한글이 섞여 있어요. 키만 다시 붙여 넣어 주세요.", true); return; }
    if (!key) { setStatus("API 키를 넣어 주세요. 키가 없으면 'AI 없이 계산'을 눌러요.", true); $("apiKey").focus(); return; }
    rememberKey(key);
    var Anthropic;
    try { Anthropic = await getSdk(); } catch (e) { setStatus(e.message, true); return; }
    start("ai");
    var client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    var tools = toolDefs(), system = systemPrompt();
    var messages = [{ role: "user", content: "오늘 조건으로 스크랩 배합을 설계해 주세요. 조건은 get_conditions로 읽을 수 있어요." }];
    try {
      for (var turn = 1; turn <= MAX_TURNS; turn++) {
        setStatus("Claude가 생각하는 중… (" + turn + "번째 호출)");
        showWaiting(true);
        var resp = await client.beta.messages.create({
          model: MODEL, max_tokens: 16000, system: system, tools: tools, messages: messages,
          thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"
        });
        showWaiting(false);
        var u = resp.usage || {};
        run.usage.in += u.input_tokens || 0; run.usage.out += u.output_tokens || 0;
        run.usage.cacheR += u.cache_read_input_tokens || 0; run.usage.cacheW += u.cache_creation_input_tokens || 0;
        drawUsage();
        messages.push({ role: "assistant", content: resp.content });   // 생각 블록까지 그대로 돌려준다
        resp.content.forEach(function (b) {
          if (b.type === "thinking" && b.thinking && b.thinking.trim()) emit({ t: "thinking", text: b.thinking.trim() });
          else if (b.type === "text" && b.text.trim()) emit({ t: "text", text: b.text.trim() });
          else if (b.type === "tool_use") emit({ t: "call", name: b.name, input: b.input });
        });
        if (resp.stop_reason === "refusal") { finish("error", "Claude가 이 요청을 거절했어요."); return; }
        if (resp.stop_reason === "max_tokens") { finish("error", "응답이 길어서 중간에 잘렸어요. 다시 실행해 주세요."); return; }
        if (resp.stop_reason === "pause_turn") continue;
        if (resp.stop_reason !== "tool_use") {
          var last = resp.content.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n").trim();
          run.conclusion = last;
          finish(run.last ? "done" : "error", run.last ? "" : "배합을 계산하기 전에 대화가 끝났어요.");
          return;
        }
        var results = [];
        resp.content.forEach(function (b) {
          if (b.type !== "tool_use") return;
          var out, isErr = false;
          try { out = TOOLS_IMPL[b.name] ? TOOLS_IMPL[b.name](b.input || {}) : { error: "없는 도구: " + b.name }; isErr = !!out.error; }
          catch (e) { out = { error: String(e.message || e) }; isErr = true; }
          emit({ t: "result", name: b.name, out: out, err: isErr });
          results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out), is_error: isErr });
        });
        messages.push({ role: "user", content: results });   // 결과는 한 메시지에 모아서
      }
      finish(run.last ? "done" : "error", "호출 횟수 한도(" + MAX_TURNS + "번)에 닿아 멈췄어요.");
    } catch (err) {
      showWaiting(false);
      finish("error", apiErrorText(Anthropic, err));
    }
  }
  function apiErrorText(A, err) {
    if (A && err instanceof A.AuthenticationError) return "API 키가 올바르지 않아요. 키를 다시 확인해 주세요.";
    if (A && err instanceof A.PermissionDeniedError) return "이 키로는 이 모델을 쓸 권한이 없어요.";
    if (A && err instanceof A.RateLimitError) return "요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.";
    if (A && err instanceof A.BadRequestError) return "요청 형식 오류: " + (err.message || "");
    if (A && err instanceof A.APIConnectionError) return "Claude 서버에 연결하지 못했어요. 인터넷 연결을 확인하세요.";
    if (A && err instanceof A.APIError) return "Claude API 오류 (" + err.status + "): " + (err.message || "");
    return "실행 중 오류: " + (err && err.message ? err.message : String(err));
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
      var o = TOOLS_IMPL.optimize_blend(inp); emit({ t: "result", name: "optimize_blend", out: o, err: o.status !== "ok" });
      if (o.status !== "ok") {
        var shrunk = {}; Object.keys(margins).forEach(function (s) { shrunk[s] = { cu: r5(margins[s].cu * 0.8), sn: r5(margins[s].sn * 0.8) }; });
        margins = shrunk; continue;
      }
      emit({ t: "call", name: "simulate_blend", input: {} });
      var sres = TOOLS_IMPL.simulate_blend(); emit({ t: "result", name: "simulate_blend", out: sres });
      if (sres.all_pass) break;
      margins = sres.suggested_margins;
    }
    run.conclusion = run.last ? "키워드 규칙과 정해진 조정 규칙으로 계산한 결과예요. 메모의 문맥(예: '전량 제거 완료')은 읽지 못하니, 판정이 이상하면 AI로 다시 풀어 보세요." : "";
    finish(run.last ? "done" : "error", run.last ? "" : "조건을 만족하는 배합을 찾지 못했어요.");
  }

  function start(mode) {
    busy = true; presenting = false; $("tl").classList.remove("present");
    run = newRun(mode);
    $("tl").innerHTML = ""; $("tlBox").hidden = false; $("resBox").hidden = true; $("replayBar").hidden = true;
    $("aiBtn").disabled = $("plainBtn").disabled = true;
    drawUsage();
    $("tlBox").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }
  function finish(status, msg) {
    busy = false; showWaiting(false);
    run.status = status;
    if (msg) emit({ t: "error", text: msg });
    if (status === "done") { emit({ t: "done", text: run.conclusion }); setStatus(run.mode === "ai" ? "Claude가 배합을 다 풀었어요." : "계산을 마쳤어요."); }
    else setStatus(msg || "실행을 마치지 못했어요.", true);
    showErrors();
    if (run.last) { drawResult(run); saveRun(run); }
    dirty = false; drawSaved();
    $("replayBar").hidden = false;
  }

  /* ====================================================================
     5. 과정(타임라인) 그리기
     ==================================================================== */
  var TOOL_KO = { get_conditions: "조건 읽기", optimize_blend: "원가 최소 배합 계산", simulate_blend: "모의 조업 검증" };
  function mdLite(s) {    // Claude 문장의 **굵게**, - 목록, 줄바꿈만 살린다
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
  function rulesHtml(rules, notes) {
    if (!rules || !rules.length) return "";
    return '<ul class="rules-l">' + rules.map(function (r) {
      var n = (notes || []).filter(function (x) { return x.id === r.note_id; })[0], a = ACT[r.action] || ACT.none;
      return "<li>" + '<span class="pill ' + a[0] + '">' + a[1] + "</span> " + (n ? "“" + esc(n.text) + "”" : esc(r.note_id)) +
        (r.reason ? ' <span class="muted">— ' + esc(r.reason) + "</span>" : "") + "</li>";
    }).join("") + "</ul>";
  }
  function eventHtml(ev, notes) {
    if (ev.t === "thinking") return '<div class="ev-h"><span class="pill mute">🧠 생각</span></div><div class="ev-b think">' + mdLite(ev.text) + "</div>";
    if (ev.t === "text") return '<div class="ev-h"><span class="pill info">💬 AI</span></div><div class="ev-b">' + mdLite(ev.text) + "</div>";
    if (ev.t === "call") {
      var body = "";
      if (ev.name === "optimize_blend") body = '<div class="ev-sub">안전여유</div>' + marginChips(ev.input.margins) + (ev.input.note_rules && ev.input.note_rules.length ? '<div class="ev-sub">검수 메모 판정</div>' + rulesHtml(ev.input.note_rules, notes) : "");
      return '<div class="ev-h"><span class="pill point">🔧 도구 호출</span> <b>' + (TOOL_KO[ev.name] || esc(ev.name)) + '</b> <span class="mono muted">' + esc(ev.name) + "</span></div>" + (body ? '<div class="ev-b">' + body + "</div>" : "");
    }
    if (ev.t === "result") {
      var o = ev.out || {}, h = "";
      if (ev.err || o.error) h = '<span class="pill crit">실패</span> ' + esc(o.error || o.message || "") + (o.hint ? '<br><span class="muted">' + esc(o.hint) + "</span>" : "");
      else if (ev.name === "get_conditions") h = "등급 " + o.grades.length + "개 · 강종 " + o.steels.length + "개 · heat " + o.steels.reduce(function (a, t) { return a + t.heats; }, 0) + "개 · 검수 메모 " + o.notes.length + "건 · 목표 이탈 " + (o.target_fail_prob * 100) + "%<br>" + '<div class="ev-sub">첫 안전여유 제안</div>' + marginChips(o.initial_margin_suggestion);
      else if (ev.name === "optimize_blend") h = "<b class=\"chem\">톤당 " + won(o.cost_per_t_krw) + "원</b> (" + o.iteration + "번째 계산)" +
        (o.excluded_grades.length ? ' · 제외 <b>' + esc(o.excluded_grades.join(", ")) + "</b>" : "") + (o.capped_grades.length ? " · 5% 제한 " + esc(o.capped_grades.join(", ")) : "") +
        '<div class="ev-sub">강종별 예상 성분</div>' + Object.keys(o.by_steel).map(function (s) { var v = o.by_steel[s]; return '<span class="pill mute">' + esc(s) + " Cu " + v.pred_cu_pct.toFixed(3) + "/" + v.cu_max_pct + "%</span>"; }).join(" ");
      else if (ev.name === "simulate_blend") h = (o.all_pass ? '<span class="pill good">✓ 모두 통과</span>' : '<span class="pill crit">목표 초과 있음</span>') + " 모의 조업 " + N_SIM.toLocaleString("ko-KR") + "회, 목표 " + o.target_p_fail_pct + "%<br>" +
        Object.keys(o.by_steel).map(function (s) { var v = o.by_steel[s]; return '<span class="pill ' + (v.pass ? "good" : "crit") + '">' + esc(s) + " 최대 " + v.max_p_fail_pct.toFixed(1) + "% " + (v.pass ? "✓" : "✗") + "</span>"; }).join(" ");
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
    $("usage").textContent = "토큰 입력 " + (u.in + u.cacheR + u.cacheW).toLocaleString("ko-KR") + " · 출력 " + u.out.toLocaleString("ko-KR") + " · 약 $" + usd.toFixed(3);
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
    var pass = L.sim.every(function (x) { return x.p_fail <= r.spec.target; });
    var tap = o.heats.reduce(function (a, h) { return a + h.tap; }, 0);
    $("resBox").hidden = false;
    $("resMeta").textContent = (r.mode === "ai" ? "Claude 에이전트" : "AI 없이 (키워드 규칙)") + " · " + new Date(r.at).toLocaleString("ko-KR") + " · 최적화 " + r.optCalls + "회";
    $("resTiles").innerHTML = [
      ["톤당 배합 원가", won(o.costPerT) + "원", "하루 " + Math.round(tap).toLocaleString("ko-KR") + "t 출강 기준"],
      expert ? ["숙련자 배합 대비", "−" + won(expert.costPerT - o.costPerT) + "원/t", ((expert.costPerT - o.costPerT) / expert.costPerT * 100).toFixed(1) + "% 절감 · 숙련자 " + won(expert.costPerT) + "원"]
             : ["숙련자 배합 대비", "비교 없음", "등급 구성이 기본 8종과 달라 숙련자 배합표를 쓸 수 없어요"],
      ["예측 최대 이탈 확률", (maxH.p_fail * 100).toFixed(1) + "%", maxH.heat_id + " " + maxH.steel + " · 목표 " + (r.spec.target * 100) + "% " + (pass ? "통과" : "초과"), !pass],
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
        '</span></td><td class="r">' + (p > r.spec.target * 100 ? '<span class="pill crit">' + p.toFixed(1) + "%</span>" : p.toFixed(1) + "%") + '</td><td class="r num">' + won(h.costPerT) + "</td></tr>";
    }).join("");
  }

  /* ====================================================================
     7. 실행 기록 저장·불러오기 (이 브라우저, 최근 5건)
     ==================================================================== */
  function saveRun(r) {
    var rec = { at: r.at, mode: r.mode, spec: r.spec, events: r.events, usage: r.usage, conclusion: r.conclusion, optCalls: r.optCalls, status: r.status,
                last: r.last ? { margins: r.last.margins, rules: r.last.rules, seed: r.last.seed } : null,
                cost: r.last ? Math.round(r.last.opt.costPerT) : null };
    var all = P.store.get(RUNS_KEY, []); all.unshift(rec); P.store.set(RUNS_KEY, all.slice(0, 5));
  }
  function loadRun(rec) {
    var su = E.customSetup(engineSpec(rec.spec));
    var r = { mode: rec.mode, at: rec.at, spec: rec.spec, su: su, events: rec.events, usage: rec.usage, conclusion: rec.conclusion, optCalls: rec.optCalls, status: rec.status, last: null };
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
    if (r.last) drawResult(r); else $("resBox").hidden = true;
    setStatus("저장된 실행을 불러왔어요. '발표 모드'로 한 단계씩 다시 볼 수 있어요.");
  }
  function drawSaved() {
    var all = P.store.get(RUNS_KEY, []);
    $("savedRuns").innerHTML = '<option value="">최근 실행 다시 보기…</option>' + all.map(function (r, i) {
      return '<option value="' + i + '">' + new Date(r.at).toLocaleString("ko-KR") + " · " + (r.mode === "ai" ? "Claude" : "AI 없이") + (r.cost ? " · " + won(r.cost) + "원/t" : " · 미완료") + "</option>";
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
    restoreKey(); drawSaved();
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
  }
  window.ReBornDesigner = { tools: TOOLS_IMPL, getRun: function () { return run; } };   // 시험용
  P.start(render);
})();
