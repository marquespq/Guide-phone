/* Mapa de furtos e roubos de celular — Grande Porto Alegre
 * Lê web/data/stats.json (gerado por scripts/update_data.py) e os contornos do IBGE.
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const fmt = new Intl.NumberFormat("pt-BR");
  const fmt1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const POP_MINIMA = 3000; // abaixo disso a taxa por mil moradores distorce demais (ex.: bairro com shopping e poucos moradores)

  const estado = { tipo: "ambos", horario: "todos", periodo: "12m", medida: "total", cidade: "", sel: null };
  let D, mun, bai, map, valores, classes;

  // ---------- utilidades ----------
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const rampa = () => ["--s0", "--s1", "--s2", "--s3", "--s4"].map(css);
  const nomeMes = (m) => { const [a, n] = m.split("-"); return MESES[+n - 1] + "/" + a.slice(2); };
  const escuro = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

  function intervaloMeses() {
    const n = D.meses.length;
    if (estado.periodo === "12m") return [Math.max(0, n - 12), n - 1];
    if (estado.periodo === "tudo") return [0, n - 1];
    const idx = D.meses.map((m, i) => (m.startsWith(estado.periodo) ? i : -1)).filter((i) => i >= 0);
    return [idx[0], idx[idx.length - 1]];
  }

  function textoPeriodo() {
    const [a, b] = intervaloMeses();
    return nomeMes(D.meses[a]) + " a " + nomeMes(D.meses[b]);
  }

  function passa(l) {
    if (estado.tipo === "furto" && l[2] !== 0) return false;
    if (estado.tipo === "roubo" && l[2] !== 1) return false;
    if (estado.horario === "dia" && l[3] !== 0) return false;
    if (estado.horario === "noite" && l[3] !== 1) return false;
    return true;
  }

  // ---------- agregação ----------
  function agregar() {
    const [a, b] = intervaloMeses();
    const porArea = new Float64Array(D.areas.length);
    const porMun = {};
    for (const l of D.linhas) {
      if (l[1] < a || l[1] > b || !passa(l)) continue;
      porArea[l[0]] += l[4];
      const m = D.areas[l[0]].mun;
      porMun[m] = (porMun[m] || 0) + l[4];
    }
    return { porArea, porMun };
  }

  function medida(n, pop) {
    if (estado.medida === "total") return n;
    if (!pop || pop < POP_MINIMA) return null;
    return (n / pop) * 1000;
  }

  // quebras por quantis (20/40/60/80%) sobre os bairros com mapa e valor > 0
  function quebras(vals) {
    const v = vals.filter((x) => x != null && x > 0).sort((p, q) => p - q);
    if (!v.length) return [];
    const q = [0.2, 0.4, 0.6, 0.8].map((p) => v[Math.min(v.length - 1, Math.floor(p * v.length))]);
    const arred = q.map((x) => (estado.medida === "total" ? Math.max(1, Math.round(x)) : Math.round(x * 10) / 10));
    return arred.filter((x, i) => i === 0 || x > arred[i - 1]);
  }

  function classe(v) {
    if (v == null) return -2;
    if (v === 0) return -1;
    let c = 0;
    while (c < classes.length && v > classes[c]) c++;
    return Math.min(c, 4);
  }

  function cor(c) {
    if (c === -2) return css("--sem-dado");
    if (c === -1) return css("--zero");
    return rampa()[c + (5 - (classes.length + 1))] || rampa()[4];
  }

  // ---------- atualização ----------
  function atualizar() {
    const { porArea, porMun } = agregar();
    valores = { porArea, porMun };

    const cidade = estado.cidade;
    const geoVals = [];
    D.areas.forEach((a, i) => {
      if (a.geo && (!cidade || a.mun === cidade)) geoVals.push(medida(porArea[i], a.pop));
    });
    if (estado.medida === "taxa") {
      for (const [cd, m] of Object.entries(D.municipios)) {
        if (!m.tem_bairros && (!cidade || cd === cidade)) geoVals.push(medida(porMun[cd] || 0, m.pop));
      }
    }
    classes = quebras(geoVals);

    if (map && map.getSource("bai")) pintar();
    resumo();
    legenda();
    ranking();
    if (estado.sel) detalhe(estado.sel);
  }

  function pintar() {
    const { porArea, porMun } = valores;
    const transparente = "rgba(0,0,0,0)";
    const fora = (cd) => estado.cidade && cd !== estado.cidade; // escala vale só para a cidade escolhida
    D.areas.forEach((a, i) => {
      if (!a.geo) return;
      const v = medida(porArea[i], a.pop);
      map.setFeatureState({ source: "bai", id: a.id }, { cor: fora(a.mun) ? transparente : cor(classe(v)) });
    });
    for (const [cd, m] of Object.entries(D.municipios)) {
      let c = transparente;
      if (!m.tem_bairros && !fora(cd)) {
        c = estado.medida === "taxa" ? cor(classe(medida(porMun[cd] || 0, m.pop))) : css("--sem-dado");
      }
      map.setFeatureState({ source: "mun", id: cd }, { cor: c });
    }
    map.setPaintProperty("bai-linha", "line-color", css("--contorno-bairro"));
    map.setPaintProperty("mun-linha", "line-color", css("--contorno-mun"));
    map.setFilter("sel-linha", ["==", ["get", "CD_BAIRRO"], estado.sel && D.areas[estado.sel.i] && D.areas[estado.sel.i].geo ? D.areas[estado.sel.i].id : ""]);
    map.setFilter("sel-mun", ["==", ["get", "CD_MUN"], estado.sel && estado.sel.mun ? estado.sel.mun : ""]);
  }

  function resumo() {
    const { porMun } = valores;
    const total = estado.cidade ? porMun[estado.cidade] || 0 : Object.values(porMun).reduce((s, x) => s + x, 0);
    const onde = estado.cidade ? D.municipios[estado.cidade].nome : D.regiao;
    const tipo = { ambos: "furtos e roubos", furto: "furtos", roubo: "roubos" }[estado.tipo];
    const hora = { todos: "", dia: " de dia", noite: " à noite" }[estado.horario];
    $("#total").textContent = fmt.format(total);
    $("#total-desc").textContent = `${tipo}${hora} · ${onde} · ${textoPeriodo()}`;
  }

  function legenda() {
    const r = rampa();
    const n = classes.length + 1;
    const usadas = r.slice(5 - n);
    const fmtv = estado.medida === "total" ? (x) => fmt.format(x) : (x) => fmt1.format(x);
    // cada limite fica centralizado na divisa entre duas caixas (34px + 2px de vão)
    const limites = classes.map((x, i) => `<span style="left:${(i + 1) * 36 - 1}px">${fmtv(x)}</span>`).join("");
    const unidade = estado.medida === "total" ? "ocorrências por bairro" : "ocorrências por mil moradores";
    $("#legenda").innerHTML = `
      <div class="escala">menos <span class="caixas">${usadas.map((c) => `<span style="background:${c}"></span>`).join("")}</span> mais</div>
      <div class="limites" style="margin-left:42px">${limites}</div>
      <div class="extra">
        <span><i style="background:${css("--zero")}"></i>nenhum registro</span>
        <span><i class="hachura" style="background-color:${css("--sem-dado")}"></i>cidade sem mapa de bairros (toque para ver a lista)</span>
      </div>
      <div class="extra" style="margin-top:4px">${unidade}, ${textoPeriodo()}</div>`;
  }

  function ranking() {
    const { porArea } = valores;
    const itens = [];
    D.areas.forEach((a, i) => {
      if (a.id.startsWith("?:")) return;
      if (estado.cidade && a.mun !== estado.cidade) return;
      const v = medida(porArea[i], a.pop);
      if (v == null || v <= 0) return;
      itens.push({ i, a, v });
    });
    itens.sort((p, q) => q.v - p.v);
    const top = itens.slice(0, 12);
    const max = top.length ? top[0].v : 1;
    const fmtv = estado.medida === "total" ? (x) => fmt.format(x) : (x) => fmt1.format(x);
    $("#ranking-titulo").textContent = estado.medida === "total" ? "Bairros com mais registros" : "Maior taxa por mil moradores";
    $("#ranking").innerHTML = top.length
      ? top.map((t) => `
        <li><button data-i="${t.i}">
          <span class="nome">${t.a.nome}${estado.cidade ? "" : `<small>${D.municipios[t.a.mun].nome}</small>`}</span>
          <span class="val">${fmtv(t.v)}</span>
          <span class="barra"><span style="width:${((t.v / max) * 100).toFixed(1)}%"></span></span>
        </button></li>`).join("")
      : `<li class="desc">Nenhum registro com esses filtros.</li>`;
  }

  // ---------- detalhe ----------
  function serieMensal(filtroArea) {
    const s = new Array(D.meses.length).fill(0);
    for (const l of D.linhas) if (filtroArea(l[0]) && passa(l)) s[l[1]] += l[4];
    return s;
  }

  function graficoSerie(s) {
    const [a, b] = intervaloMeses();
    const max = Math.max(1, ...s);
    const w = 100 / s.length;
    const barras = s.map((v, i) => {
      const h = (v / max) * 86;
      return `<rect x="${(i * w + w * 0.1).toFixed(2)}" y="${(88 - h).toFixed(2)}" width="${(w * 0.8).toFixed(2)}" height="${Math.max(h, v ? 1 : 0).toFixed(2)}" rx="0.4"
        class="${i >= a && i <= b ? "dentro" : ""}" data-m="${i}" data-v="${v}"></rect>`;
    }).join("");
    return `<div class="serie"><svg viewBox="0 0 100 88" preserveAspectRatio="none" role="img" aria-label="Ocorrências por mês">${barras}</svg>
      <div class="eixo"><span>${nomeMes(D.meses[0])}</span><span>por mês</span><span>${nomeMes(D.meses[D.meses.length - 1])}</span></div></div>`;
  }

  function detalhe(sel) {
    const box = $("#detalhe");
    const { porArea, porMun } = valores;
    let html;
    if (sel.mun) {
      // município sem malha de bairros: lista os bairros informados
      const m = D.municipios[sel.mun];
      const n = porMun[sel.mun] || 0;
      const taxa = medida(n, m.pop);
      const lista = [];
      D.areas.forEach((a, i) => { if (a.mun === sel.mun && porArea[i] > 0) lista.push({ a, v: porArea[i] }); });
      lista.sort((p, q) => q.v - p.v);
      const serie = serieMensal((i) => D.areas[i].mun === sel.mun);
      html = `
        <div class="topo"><div><h3>${m.nome}</h3><div class="cidade">cidade inteira · ${textoPeriodo()}</div></div>
        <button class="fechar" aria-label="Fechar">×</button></div>
        <div class="kpis">
          <div class="kpi"><b>${fmt.format(n)}</b><span>ocorrências</span></div>
          <div class="kpi"><b>${taxa == null ? "–" : fmt1.format((n / m.pop) * 1000)}</b><span>por mil moradores</span></div>
          <div class="kpi"><b>${fmt.format(m.pop || 0)}</b><span>moradores</span></div>
        </div>
        ${graficoSerie(serie)}
        <p class="aviso">O IBGE não tem mapa de bairros desta cidade. Bairros como foram escritos no registro:</p>
        <ol id="lista-bairros" style="margin:6px 0 0;padding-left:20px;font-size:13px">${lista.slice(0, 15).map((x) => `<li>${x.a.nome} <span style="color:var(--text-3)">${fmt.format(x.v)}</span></li>`).join("")}</ol>`;
    } else {
      const a = D.areas[sel.i];
      const n = porArea[sel.i];
      const serie = serieMensal((i) => i === sel.i);
      const temTaxa = a.pop && a.pop >= POP_MINIMA;
      // participação no total da cidade
      const totMun = porMun[a.mun] || 0;
      html = `
        <div class="topo"><div><h3>${a.nome}</h3><div class="cidade">${D.municipios[a.mun].nome} · ${textoPeriodo()}</div></div>
        <button class="fechar" aria-label="Fechar">×</button></div>
        <div class="kpis">
          <div class="kpi"><b>${fmt.format(n)}</b><span>ocorrências</span></div>
          <div class="kpi"><b>${temTaxa ? fmt1.format((n / a.pop) * 1000) : "–"}</b><span>por mil moradores</span></div>
          <div class="kpi"><b>${totMun ? fmt1.format((n / totMun) * 100) + "%" : "–"}</b><span>da cidade</span></div>
        </div>
        ${graficoSerie(serie)}
        ${a.geo ? "" : `<p class="aviso">Sem contorno no mapa: o IBGE não tem bairros desta cidade.</p>`}
        ${a.pop && !temTaxa ? `<p class="aviso">População muito pequena (${fmt.format(a.pop)}) para calcular taxa.</p>` : ""}`;
    }
    box.innerHTML = html;
    box.hidden = false;
    box.querySelector(".fechar").onclick = () => selecionar(null);
    ligarDicaSerie(box);
  }

  function ligarDicaSerie(box) {
    const dica = $("#dica");
    box.querySelectorAll(".serie rect").forEach((r) => {
      r.addEventListener("mousemove", (e) => {
        dica.innerHTML = `<b>${nomeMes(D.meses[+r.dataset.m])}</b><span>${fmt.format(+r.dataset.v)} ocorrências</span>`;
        posicionarDica(e.clientX, e.clientY);
        r.classList.add("hover");
      });
      r.addEventListener("mouseleave", () => { dica.hidden = true; r.classList.remove("hover"); });
    });
  }

  function posicionarDica(x, y) {
    const dica = $("#dica");
    dica.hidden = false;
    const w = dica.offsetWidth, h = dica.offsetHeight;
    dica.style.left = Math.min(window.innerWidth - w - 8, x + 14) + "px";
    dica.style.top = Math.max(8, y - h - 10) + "px";
  }

  function selecionar(sel, voar) {
    estado.sel = sel;
    if (!sel) { $("#detalhe").hidden = true; }
    else detalhe(sel);
    if (map && map.getSource("bai")) pintar();
    if (voar && sel) {
      const id = sel.mun ? sel.mun : D.areas[sel.i].geo ? D.areas[sel.i].id : D.areas[sel.i].mun;
      const fonte = sel.mun || !D.areas[sel.i].geo ? mun : bai;
      const campo = fonte === mun ? "CD_MUN" : "CD_BAIRRO";
      const f = fonte.features.find((x) => x.properties[campo] === id);
      if (f) map.fitBounds(caixa(f), { padding: paddingMapa(), maxZoom: 14, duration: 700 });
    }
    $("#painel").classList.remove("recolhido");
  }

  // ---------- mapa ----------
  function caixa(f) {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    const visita = (c) => { if (typeof c[0] === "number") { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); } else c.forEach(visita); };
    visita(f.geometry.coordinates);
    return [[x0, y0], [x1, y1]];
  }

  function paddingMapa() {
    return window.innerWidth > 720 ? { left: 420, top: 40, right: 40, bottom: 40 } : { left: 20, right: 20, top: 20, bottom: Math.round(window.innerHeight * 0.4) };
  }

  function hachura() {
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const g = c.getContext("2d");
    g.strokeStyle = css("--contorno-mun");
    g.globalAlpha = 0.55;
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
    return g.getImageData(0, 0, 8, 8);
  }

  function adicionarCamadas() {
    // nossas camadas ficam acima de ruas/áreas e abaixo dos rótulos do mapa base
    const camadas = map.getStyle().layers;
    let ultimaNaoRotulo = -1;
    camadas.forEach((l, i) => { if (l.type !== "symbol") ultimaNaoRotulo = i; });
    const primeiroSimbolo = (camadas.slice(ultimaNaoRotulo + 1).find((l) => l.type === "symbol") || {}).id;
    const semBairros = Object.entries(D.municipios).filter(([, m]) => !m.tem_bairros).map(([cd]) => cd);

    map.addSource("mun", { type: "geojson", data: mun, promoteId: "CD_MUN" });
    map.addSource("bai", { type: "geojson", data: bai, promoteId: "CD_BAIRRO" });
    if (map.hasImage("hachura")) map.removeImage("hachura");
    map.addImage("hachura", hachura());

    const corEstado = ["coalesce", ["feature-state", "cor"], "rgba(0,0,0,0)"];
    map.addLayer({ id: "mun-fill", type: "fill", source: "mun", paint: { "fill-color": corEstado, "fill-opacity": 0.72 } }, primeiroSimbolo);
    map.addLayer({ id: "mun-hachura", type: "fill", source: "mun", filter: ["in", ["get", "CD_MUN"], ["literal", semBairros]], paint: { "fill-pattern": "hachura" } }, primeiroSimbolo);
    map.addLayer({ id: "bai-fill", type: "fill", source: "bai", paint: { "fill-color": corEstado, "fill-opacity": 0.75 } }, primeiroSimbolo);
    map.addLayer({ id: "bai-linha", type: "line", source: "bai", paint: { "line-color": css("--contorno-bairro"), "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.3, 13, 1.2] } }, primeiroSimbolo);
    map.addLayer({ id: "mun-linha", type: "line", source: "mun", paint: { "line-color": css("--contorno-mun"), "line-width": 1.2, "line-opacity": 0.8 } }, primeiroSimbolo);
    map.addLayer({ id: "sel-linha", type: "line", source: "bai", filter: ["==", ["get", "CD_BAIRRO"], ""], paint: { "line-color": css("--text"), "line-width": 2.5 } });
    map.addLayer({ id: "sel-mun", type: "line", source: "mun", filter: ["==", ["get", "CD_MUN"], ""], paint: { "line-color": css("--text"), "line-width": 2.5 } });
    pintar();
  }

  function dicaMapa(e) {
    const f = map.queryRenderedFeatures(e.point, { layers: ["bai-fill", "mun-fill"] });
    const dica = $("#dica");
    if (!f.length) { dica.hidden = true; map.getCanvas().style.cursor = ""; return; }
    map.getCanvas().style.cursor = "pointer";
    const b = f.find((x) => x.layer.id === "bai-fill");
    const m = f.find((x) => x.layer.id === "mun-fill");
    const fmtv = (v) => (estado.medida === "total" ? fmt.format(v) + " ocorrências" : fmt1.format(v) + " por mil moradores");
    if (b) {
      const i = indice[b.properties.CD_BAIRRO];
      const a = D.areas[i];
      const v = i == null ? 0 : medida(valores.porArea[i], a.pop);
      dica.innerHTML = `<b>${b.properties.NM_BAIRRO}</b><span>${D.municipios[b.properties.CD_MUN].nome} · ${v == null ? "população pequena demais para taxa" : fmtv(v)}</span>`;
    } else if (m) {
      const cd = m.properties.CD_MUN, mm = D.municipios[cd];
      if (mm.tem_bairros) { dica.innerHTML = `<b>${mm.nome}</b><span>fora dos bairros mapeados</span>`; }
      else {
        const v = medida(valores.porMun[cd] || 0, mm.pop);
        dica.innerHTML = `<b>${mm.nome}</b><span>cidade inteira · ${v == null ? "–" : fmtv(v)}</span>`;
      }
    }
    posicionarDica(e.originalEvent.clientX, e.originalEvent.clientY);
  }

  function cliqueMapa(e) {
    const f = map.queryRenderedFeatures(e.point, { layers: ["bai-fill", "mun-fill"] });
    const b = f.find((x) => x.layer.id === "bai-fill");
    const m = f.find((x) => x.layer.id === "mun-fill");
    if (b && indice[b.properties.CD_BAIRRO] != null) selecionar({ i: indice[b.properties.CD_BAIRRO] });
    else if (m && !D.municipios[m.properties.CD_MUN].tem_bairros) selecionar({ mun: m.properties.CD_MUN });
    else selecionar(null);
  }

  let indice = {};

  function estilo() {
    return "https://tiles.openfreemap.org/styles/" + (escuro() ? "dark" : "positron");
  }

  function iniciarMapa() {
    map = new maplibregl.Map({
      container: "map",
      style: estilo(),
      bounds: caixa({ geometry: { coordinates: mun.features.map((f) => f.geometry.coordinates) } }),
      fitBoundsOptions: { padding: paddingMapa() },
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("style.load", adicionarCamadas);
    map.on("mousemove", dicaMapa);
    map.on("mouseout", () => { $("#dica").hidden = true; });
    map.on("click", cliqueMapa);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      map.setStyle(estilo());
      atualizar();
    });
  }

  // ---------- controles ----------
  function montarControles() {
    const anos = [...new Set(D.meses.map((m) => m.slice(0, 4)))].reverse();
    const per = $("#periodo");
    const ultimo = D.meses[D.meses.length - 1];
    per.innerHTML =
      `<option value="12m">Últimos 12 meses</option>` +
      anos.map((a) => {
        const ms = D.meses.filter((m) => m.startsWith(a));
        const parcial = ms.length < 12 ? ` (${MESES[+ms[0].slice(5) - 1]}–${MESES[+ms[ms.length - 1].slice(5) - 1]})` : "";
        return `<option value="${a}">${a}${parcial}</option>`;
      }).join("") +
      `<option value="tudo">Tudo (${nomeMes(D.meses[0])} a ${nomeMes(ultimo)})</option>`;
    per.onchange = () => { estado.periodo = per.value; atualizar(); };

    const cid = $("#cidade");
    Object.entries(D.municipios)
      .sort((a, b) => (b[1].pop || 0) - (a[1].pop || 0))
      .forEach(([cd, m]) => cid.insertAdjacentHTML("beforeend", `<option value="${cd}">${m.nome}</option>`));
    cid.onchange = () => {
      estado.cidade = cid.value;
      atualizar();
      const f = cid.value ? mun.features.find((x) => x.properties.CD_MUN === cid.value) : { geometry: { coordinates: mun.features.map((x) => x.geometry.coordinates) } };
      map.fitBounds(caixa(f), { padding: paddingMapa(), duration: 700 });
    };

    document.querySelectorAll(".seg").forEach((seg) => {
      seg.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        estado[seg.dataset.filtro] = b.dataset.v;
        atualizar();
      });
    });

    $("#ranking").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]");
      if (!b) return;
      selecionar({ i: +b.dataset.i }, true);
    });

    $("#alca").onclick = () => $("#painel").classList.toggle("recolhido");
    if (window.innerWidth <= 720) $("#painel").classList.add("recolhido");

    $("#nome-regiao").textContent = D.regiao;
    const atual = new Date(D.atualizado_em);
    $("#nota-dados").textContent = `Dados de ${nomeMes(D.meses[0])} a ${nomeMes(ultimo)}, verificados em ${atual.toLocaleDateString("pt-BR")}.`;
  }

  // ---------- início ----------
  Promise.all(["data/stats.json", "data/municipios.geojson", "data/bairros.geojson"].map((u) => fetch(u).then((r) => r.json())))
    .then(([s, m, b]) => {
      D = s; mun = m; bai = b;
      D.areas.forEach((a, i) => { indice[a.id] = i; });
      montarControles();
      atualizar();
      iniciarMapa();
    })
    .catch((err) => {
      document.body.insertAdjacentHTML("beforeend", `<p style="position:fixed;top:40%;width:100%;text-align:center">Não foi possível carregar os dados (${err.message}).</p>`);
    });
})();
