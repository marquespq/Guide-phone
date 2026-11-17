/* Mapa de furtos e roubos — Grande Porto Alegre
 * Lê web/data/stats.json (gerado por scripts/update_data.py) e os contornos do IBGE.
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const fmt = new Intl.NumberFormat("pt-BR");
  const fmt1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const POP_MINIMA = 3000; // abaixo disso a taxa por mil moradores distorce demais (ex.: bairro com shopping e poucos moradores)

  const estado = { cat: "celular", tipo: "ambos", horario: "todos", periodo: "12m", medida: "total", cidade: "", sel: null };
  let D, mun, bai, map, valores, classes;

  // ---------- utilidades ----------
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const rampa = () => ["--s0", "--s1", "--s2", "--s3", "--s4"].map(css);
  const nomeMes = (m) => { const [a, n] = m.split("-"); return MESES[+n - 1] + "/" + a.slice(2); };

  // Taxa em linguagem de gente: "1 a cada 27 moradores" em vez de "36,7 por mil".
  // Recebe a taxa por mil moradores; arredonda para um número fácil de ler.
  function umACada(taxaPorMil) {
    if (!taxaPorMil) return null;
    const n = 1000 / taxaPorMil;
    const r = n < 20 ? Math.max(1, Math.round(n)) : n < 100 ? Math.round(n / 5) * 5 : n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100;
    return fmt.format(r);
  }
  const textoTaxa = (taxaPorMil) => (taxaPorMil ? `1 caso a cada ${umACada(taxaPorMil)} moradores` : "nenhum caso");

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

  // linha = [área, mês, categoria, tipo (0 furto / 1 roubo), noite (0/1), ocorrências]
  let catIdx = 0; // índice da categoria escolhida (-1 = todas)
  function passa(l, ignorarCategoria) {
    if (!ignorarCategoria && catIdx >= 0 && l[2] !== catIdx) return false;
    if (estado.tipo === "furto" && l[3] !== 0) return false;
    if (estado.tipo === "roubo" && l[3] !== 1) return false;
    if (estado.horario === "dia" && l[4] !== 0) return false;
    if (estado.horario === "noite" && l[4] !== 1) return false;
    return true;
  }

  // ---------- agregação ----------
  function agregar() {
    const [a, b] = intervaloMeses();
    const porArea = new Float64Array(D.areas.length);
    const porMun = {};
    for (const l of D.linhas) {
      if (l[1] < a || l[1] > b || !passa(l)) continue;
      porArea[l[0]] += l[5];
      const m = D.areas[l[0]].mun;
      porMun[m] = (porMun[m] || 0) + l[5];
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

  // Dois níveis: no zoom afastado o mapa pinta CIDADES (escala classesMun);
  // a partir de ZOOM_BAIRROS aparecem os BAIRROS (escala classes).
  const ZOOM_BAIRROS = 9;
  let classesMun = [];
  const nivelCidade = () => (map ? map.getZoom() < ZOOM_BAIRROS : true);

  function classe(v, cls = classes) {
    if (v == null) return -2;
    if (v === 0) return -1;
    let c = 0;
    while (c < cls.length && v > cls[c]) c++;
    return Math.min(c, 4);
  }

  function cor(c, cls = classes) {
    if (c === -2) return css("--sem-dado");
    if (c === -1) return css("--zero");
    return rampa()[c + (5 - (cls.length + 1))] || rampa()[4];
  }

  // ---------- atualização ----------
  function atualizar() {
    const { porArea, porMun } = agregar();
    valores = { porArea, porMun };

    const cidade = estado.cidade;
    classes = quebrasBairros();
    classesMun = quebras(Object.entries(D.municipios)
      .filter(([cd]) => !cidade || cd === cidade)
      .map(([cd, m]) => medida(porMun[cd] || 0, m.pop)));

    if (map && map.getSource("bai")) pintar();
    resumo();
    explicarMedida();
    legenda();
    ranking();
    if (estado.sel) detalhe(estado.sel);
  }

  // Escala dos bairros: calculada só com o que está visível na tela (ou com a
  // cidade escolhida), para as cores compararem bairros vizinhos entre si.
  let centros = {}; // CD_BAIRRO / CD_MUN -> [lon, lat]
  function visivel(id) {
    if (!map || !centros[id]) return true;
    return map.getBounds().contains(centros[id]);
  }
  function quebrasBairros() {
    const { porArea, porMun } = valores;
    const cidade = estado.cidade;
    const vals = [];
    D.areas.forEach((a, i) => {
      if (!a.geo) return;
      if (cidade ? a.mun !== cidade : !visivel(a.id)) return;
      vals.push(medida(porArea[i], a.pop));
    });
    if (estado.medida === "taxa") {
      for (const [cd, m] of Object.entries(D.municipios)) {
        if (m.tem_bairros) continue;
        if (cidade ? cd !== cidade : !visivel(cd)) continue;
        vals.push(medida(porMun[cd] || 0, m.pop));
      }
    }
    return quebras(vals);
  }
  function reescalarBairros() {
    if (nivelCidade() && !estado.cidade) return;
    const novas = quebrasBairros();
    if (JSON.stringify(novas) === JSON.stringify(classes)) return;
    classes = novas;
    pintar();
    legenda();
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
      const vm = medida(porMun[cd] || 0, m.pop);
      let c = transparente;
      if (!m.tem_bairros && !fora(cd)) {
        c = estado.medida === "taxa" ? cor(classe(vm)) : css("--sem-dado");
      }
      const cm = fora(cd) ? transparente : cor(classe(vm, classesMun), classesMun);
      map.setFeatureState({ source: "mun", id: cd }, { cor: c, corMun: cm });
    }
    map.setPaintProperty("bai-linha", "line-color", css("--contorno-bairro"));
    map.setPaintProperty("mun-linha", "line-color", css("--contorno-mun"));
    map.setFilter("sel-linha", ["==", ["get", "CD_BAIRRO"], estado.sel && D.areas[estado.sel.i] && D.areas[estado.sel.i].geo ? D.areas[estado.sel.i].id : ""]);
    const munSel = !estado.sel ? "" : estado.sel.mun ? estado.sel.mun : D.areas[estado.sel.i] && !D.areas[estado.sel.i].geo ? D.areas[estado.sel.i].mun : "";
    map.setFilter("sel-mun", ["==", ["get", "CD_MUN"], munSel]);
  }

  function resumo() {
    const { porMun } = valores;
    const total = estado.cidade ? porMun[estado.cidade] || 0 : Object.values(porMun).reduce((s, x) => s + x, 0);
    const onde = estado.cidade ? D.municipios[estado.cidade].nome : D.regiao;
    const tipo = { ambos: "furtos e roubos", furto: "furtos", roubo: "roubos" }[estado.tipo];
    const hora = { todos: "", dia: " de dia", noite: " à noite" }[estado.horario];
    const cat = catIdx >= 0 ? ` · ${D.categorias[catIdx].nome.toLowerCase()}` : " · todas as categorias";
    $("#total").textContent = fmt.format(total);
    $("#total-desc").textContent = `${tipo}${cat}${hora} · ${onde} · ${textoPeriodo()}`;
    $("#cat-desc").textContent = catIdx >= 0
      ? D.categorias[catIdx].descricao
      : "Soma de todas as categorias. Ficam de fora furtos genéricos (“furto simples”, “qualificado”), que não dizem o que foi levado.";
  }

  // Explica a medida escolhida com um exemplo real: o bairro com mais casos
  // (no filtro atual) e quanto isso dá por mil moradores.
  function explicarMedida() {
    const { porArea } = valores;
    let ex = null;
    D.areas.forEach((a, i) => {
      if (!a.geo || !a.pop || a.pop < POP_MINIMA) return;
      if (estado.cidade && a.mun !== estado.cidade) return;
      if (!ex || porArea[i] > porArea[ex.i]) ex = { i, a };
    });
    let exemplo = "";
    if (ex && porArea[ex.i] > 0) {
      const n = porArea[ex.i];
      exemplo = `<p class="ex">Exemplo: ${ex.a.nome} teve <b>${fmt.format(n)}</b> casos e tem ${fmt.format(ex.a.pop)} moradores,
        ou seja, <b>${textoTaxa((n / ex.a.pop) * 1000)}</b>.</p>`;
    }
    $("#explica-medida").innerHTML = estado.medida === "total"
      ? `<p><b>Quantos casos, tchê.</b> Soma de tudo que foi registrado em cada bairro.
          Lugar de muito movimento, como o Centro Histórico, aparece forte porque passa um mundo de gente por ali,
          e isso não quer dizer que quem mora lá corre mais risco.</p>${exemplo}`
      : `<p><b>Leva em conta o tamanho do bairro.</b> Mostra de quantos moradores sai um caso:
          “1 a cada 30” é bem pior que “1 a cada 1.400”. Assim um bairro pequeno com 50 casos pode pesar mais
          que um grandão com 200. Bairro com menos de ${fmt.format(POP_MINIMA)} moradores fica de fora, senão a conta dá uma barbaridade.</p>${exemplo}`;
  }

  function legenda() {
    const cidades = nivelCidade() && !estado.cidade;
    const cls = cidades ? classesMun : classes;
    const r = rampa();
    const n = cls.length + 1;
    const usadas = r.slice(5 - n);
    const fmtv = estado.medida === "total" ? (x) => fmt.format(x) : (x) => umACada(x);
    // cada limite fica centralizado na divisa entre duas caixas (34px + 2px de vão)
    const limites = cls.map((x, i) => `<span style="left:${(i + 1) * 36 - 1}px">${fmtv(x)}</span>`).join("");
    const unidade = estado.medida === "total" ? (cidades ? "casos por cidade" : "casos por bairro") : "os números são “1 caso a cada tantos moradores”";
    $("#legenda").innerHTML = `
      <div class="escala">
        <span>${estado.medida === "total" ? "menos" : "mais tranquilo"}</span>
        <span class="coluna">
          <span class="caixas">${usadas.map((c) => `<span style="background:${c}"></span>`).join("")}</span>
          <span class="limites">${limites}</span>
        </span>
        <span>${estado.medida === "total" ? "mais" : "mais casos"}</span>
      </div>
      <div class="extra">
        <span><i style="background:${css("--zero")}"></i>nenhum registro</span>
        ${cidades ? `<span>Aproxime o mapa ou escolha uma cidade para ver os bairros.</span>` : `<span><i class="hachura" style="background-color:${css("--sem-dado")}"></i>cidade sem mapa de bairros${estado.medida === "total" ? " (em “Por morador” ela ganha cor)" : ""}. Toque para ver a lista.</span>`}
      </div>
      <div class="extra" style="margin-top:4px">${unidade}, ${textoPeriodo()}</div>`;
  }

  function ranking() {
    const { porArea, porMun } = valores;
    const fmtv = estado.medida === "total" ? (x) => fmt.format(x) : (x) => "1 a cada " + umACada(x);
    if (nivelCidade() && !estado.cidade) {
      // visão do estado: ranking de cidades
      const cid = Object.entries(D.municipios)
        .map(([cd, m]) => ({ cd, m, v: medida(porMun[cd] || 0, m.pop) }))
        .filter((x) => x.v != null && x.v > 0)
        .sort((p, q) => q.v - p.v).slice(0, 12);
      const maxc = cid.length ? cid[0].v : 1;
      $("#ranking-titulo").textContent = estado.medida === "total" ? "Cidades com mais casos" : "Cidades com mais casos por morador";
      $("#ranking").innerHTML = cid.map((t) => `
        <li><button data-mun="${t.cd}">
          <span class="nome">${t.m.nome}</span>
          <span class="val">${fmtv(t.v)}</span>
          <span class="barra"><span style="width:${((t.v / maxc) * 100).toFixed(1)}%"></span></span>
        </button></li>`).join("") || `<li class="desc">Nenhum registro com esses filtros.</li>`;
      return;
    }
    const itens = [];
    D.areas.forEach((a, i) => {
      if (a.id.startsWith("?:") || a.id.startsWith("o:")) return;
      if (estado.cidade && a.mun !== estado.cidade) return;
      const v = medida(porArea[i], a.pop);
      if (v == null || v <= 0) return;
      itens.push({ i, a, v });
    });
    itens.sort((p, q) => q.v - p.v);
    const top = itens.slice(0, 12);
    const max = top.length ? top[0].v : 1;
    $("#ranking-titulo").textContent = estado.medida === "total" ? "Bairros com mais casos" : "Bairros com mais casos por morador";
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
    for (const l of D.linhas) if (filtroArea(l[0]) && passa(l)) s[l[1]] += l[5];
    return s;
  }

  // casos por categoria numa área, com os mesmos filtros de período/tipo/horário
  function porCategoria(filtroArea) {
    const [a, b] = intervaloMeses();
    const c = new Array(D.categorias.length).fill(0);
    for (const l of D.linhas) {
      if (l[1] < a || l[1] > b || !filtroArea(l[0]) || !passa(l, true)) continue;
      c[l[2]] += l[5];
    }
    return c;
  }

  // "O que mais acontece aqui": barrinhas por categoria; clicar troca a categoria do mapa
  function blocoCategorias(c) {
    const itens = c.map((n, i) => ({ i, n })).filter((x) => x.n > 0).sort((p, q) => q.n - p.n);
    if (!itens.length) return "";
    const max = itens[0].n;
    const total = itens.reduce((s, x) => s + x.n, 0);
    return `<div class="por-cat">
      <div class="por-cat-titulo">O que mais acontece aqui <span>${fmt.format(total)} no total</span></div>
      <ul>${itens.map((x) => `
        <li><button data-cat="${D.categorias[x.i].id}" class="${x.i === catIdx ? "on" : ""}" title="Ver ${D.categorias[x.i].nome} no mapa">
          <span class="nome">${D.categorias[x.i].nome}</span>
          <span class="num">${fmt.format(x.n)}</span>
          <span class="barra"><span style="width:${((x.n / max) * 100).toFixed(1)}%"></span></span>
        </button></li>`).join("")}</ul>
    </div>`;
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

  // Cartão com os números da área escolhida, aberto num popover sobre o mapa
  let popup = null;
  let fechandoPorCodigo = false;

  function detalhe(sel) {
    const { porArea, porMun } = valores;
    let html;
    if (sel.mun) {
      // município sem malha de bairros: lista os bairros informados
      const m = D.municipios[sel.mun];
      const n = porMun[sel.mun] || 0;
      const taxa = m.pop && m.pop >= POP_MINIMA && n ? (n / m.pop) * 1000 : null;
      const lista = [];
      D.areas.forEach((a, i) => { if (a.mun === sel.mun && porArea[i] > 0) lista.push({ a, v: porArea[i] }); });
      lista.sort((p, q) => q.v - p.v);
      const serie = serieMensal((i) => D.areas[i].mun === sel.mun);
      html = `
        <div class="topo"><div><h3>${m.nome}</h3><div class="cidade">cidade inteira · ${rotuloFiltro()}</div></div>
        <button class="fechar" aria-label="Fechar">×</button></div>
        <div class="kpis">
          <div class="kpi"><b>${fmt.format(n)}</b><span>casos</span></div>
          <div class="kpi"><b>${taxa ? "1 a cada " + umACada(taxa) : "–"}</b><span>moradores</span></div>
          <div class="kpi"><b>${fmt.format(m.pop || 0)}</b><span>moradores no total</span></div>
        </div>
        ${blocoCategorias(porCategoria((i) => D.areas[i].mun === sel.mun))}
        ${graficoSerie(serie)}
        ${m.tem_bairros
          ? `<p class="aviso">Bairros com mais casos: <button class="link ver-bairros">ver bairros no mapa →</button></p>`
          : `<p class="aviso">Sem mapa de bairros desta cidade. Bairros com mais casos, como foram escritos no registro:</p>`}
        <ol class="lista-bairros">${lista.filter((x) => !x.a.id.startsWith("?:") && !x.a.id.startsWith("o:")).slice(0, 10).map((x) => `<li><span>${x.a.nome}</span><b>${fmt.format(x.v)}</b></li>`).join("")}</ol>`;
    } else {
      const a = D.areas[sel.i];
      const n = porArea[sel.i];
      const serie = serieMensal((i) => i === sel.i);
      const temTaxa = a.pop && a.pop >= POP_MINIMA;
      // participação no total da cidade
      const totMun = porMun[a.mun] || 0;
      html = `
        <div class="topo"><div><h3>${a.nome}</h3><div class="cidade">${D.municipios[a.mun].nome} · ${rotuloFiltro()}</div></div>
        <button class="fechar" aria-label="Fechar">×</button></div>
        <div class="kpis">
          <div class="kpi"><b>${fmt.format(n)}</b><span>casos</span></div>
          <div class="kpi"><b>${temTaxa && n ? "1 a cada " + umACada((n / a.pop) * 1000) : "–"}</b><span>moradores</span></div>
          <div class="kpi"><b>${totMun ? fmt1.format((n / totMun) * 100) + "%" : "–"}</b><span>da cidade</span></div>
        </div>
        ${blocoCategorias(porCategoria((i) => i === sel.i))}
        ${graficoSerie(serie)}
        ${a.geo ? "" : `<p class="aviso">Sem contorno no mapa: o IBGE não tem bairros desta cidade.</p>`}
        ${a.pop && !temTaxa ? `<p class="aviso">População muito pequena (${fmt.format(a.pop)}) para calcular taxa.</p>` : ""}
        ${a.pop_est ? `<p class="aviso">Bairro da prefeitura. Moradores estimados somando os setores do Censo 2022 que ficam dentro dele.</p>` : ""}
        ${a.geo && !a.pop ? `<p class="aviso">Bairro muito pequeno: o Censo não tem setor dentro dele, então não dá para fazer a conta por morador.</p>` : ""}`;
    }
    const box = document.createElement("div");
    box.className = "card";
    box.innerHTML = html;
    box.querySelector(".fechar").onclick = () => selecionar(null);
    box.querySelectorAll(".por-cat button").forEach((b) => { b.onclick = () => escolherCategoria(b.dataset.cat); });
    const ver = box.querySelector(".ver-bairros");
    if (ver) ver.onclick = () => {
      const f = mun.features.find((x) => x.properties.CD_MUN === sel.mun);
      selecionar(null);
      if (f) map.fitBounds(caixa(f), { padding: paddingMapa(), duration: 700 });
    };
    ligarDicaSerie(box);
    if (popup) {
      popup.setDOMContent(box);
      if (sel.ponto) popup.setLngLat(sel.ponto);
    } else {
      popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "none", className: "popover", offset: 10, focusAfterOpen: false })
        .setLngLat(sel.ponto).setDOMContent(box).addTo(map);
      popup.on("close", () => { popup = null; if (!fechandoPorCodigo) selecionar(null); });
    }
  }

  function fecharPopup() {
    if (!popup) return;
    fechandoPorCodigo = true;
    popup.remove();
    fechandoPorCodigo = false;
    popup = null;
  }

  // "furtos e roubos · celular · nov/25 a out/26" para o cabeçalho do cartão
  function rotuloFiltro() {
    const cat = catIdx >= 0 ? D.categorias[catIdx].nome.toLowerCase() : "todas as categorias";
    const tipo = { ambos: "", furto: "furtos · ", roubo: "roubos · " }[estado.tipo];
    const hora = { todos: "", dia: " · de dia", noite: " · à noite" }[estado.horario];
    return `${tipo}${cat}${hora} · ${textoPeriodo()}`;
  }

  // centro aproximado (caixa envolvente) de um bairro ou município
  function centro(fonte, campo, id) {
    const f = fonte.features.find((x) => x.properties[campo] === id);
    if (!f) return null;
    const [[x0, y0], [x1, y1]] = caixa(f);
    return { f, ponto: [(x0 + x1) / 2, (y0 + y1) / 2] };
  }

  // Garante que o cartão caiba na área livre da tela (fora do painel lateral
  // no desktop e acima da gaveta no celular), deslocando o mapa se precisar.
  function encaixarNaTela() {
    if (!popup) return;
    requestAnimationFrame(() => {
      if (!popup) return;
      const r = popup.getElement().getBoundingClientRect();
      const celular = window.innerWidth <= 720;
      const painel = $("#painel").getBoundingClientRect();
      const livre = {
        left: celular ? 8 : painel.right + 12,
        right: window.innerWidth - 56, // controles de zoom
        top: 8,
        bottom: celular ? painel.top - 8 : window.innerHeight - 8,
      };
      let dx = 0, dy = 0;
      if (r.left < livre.left) dx = r.left - livre.left;
      else if (r.right > livre.right) dx = r.right - livre.right;
      if (r.height > livre.bottom - livre.top) dy = r.top - livre.top; // maior que a área: alinha no topo
      else if (r.bottom > livre.bottom) dy = r.bottom - livre.bottom;
      else if (r.top < livre.top) dy = r.top - livre.top;
      if (dx || dy) map.panBy([dx, dy], { duration: 350 });
    });
  }

  // tooltip das barras do gráfico mensal
  function ligarDicaSerie(box) {
    const dica = $("#dica");
    box.querySelectorAll(".serie rect").forEach((r) => {
      r.addEventListener("mousemove", (e) => {
        dica.innerHTML = `<b>${nomeMes(D.meses[+r.dataset.m])}</b><span>${fmt.format(+r.dataset.v)} casos</span>`;
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

  // gaveta do celular: aberta (true) ou recolhida (false); no desktop não faz nada visível
  function abrirPainel(aberto) {
    const p = $("#painel");
    p.classList.toggle("recolhido", !aberto);
    $("#alca").setAttribute("aria-expanded", String(aberto));
    if (!aberto) p.scrollTop = 0;
  }

  // sel = { i: área } ou { mun: código }, com ponto = [lon, lat] onde abrir o cartão
  function selecionar(sel, voar) {
    if (!sel) {
      estado.sel = null;
      fecharPopup();
      if (map && map.getSource("bai")) pintar();
      return;
    }
    let alvo = null;
    if (sel.mun) alvo = centro(mun, "CD_MUN", sel.mun);
    else if (D.areas[sel.i].geo) alvo = centro(bai, "CD_BAIRRO", D.areas[sel.i].id);
    else alvo = centro(mun, "CD_MUN", D.areas[sel.i].mun); // bairro sem contorno: abre sobre a cidade
    if (!sel.ponto && alvo) sel.ponto = alvo.ponto;
    estado.sel = sel;
    if (window.innerWidth <= 720) abrirPainel(false); // no celular, recolhe a gaveta para ver o cartão
    if (map && map.getSource("bai")) pintar();
    if (voar && alvo) {
      // voa até a área e só então abre o cartão, já com o lado certo para abrir
      fecharPopup();
      map.fitBounds(caixa(alvo.f), { padding: paddingMapa(), maxZoom: 14, duration: 700 });
      map.once("moveend", () => { if (estado.sel === sel) { detalhe(sel); encaixarNaTela(); } });
    } else {
      detalhe(sel);
      encaixarNaTela();
    }
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

    const T = "rgba(0,0,0,0)";
    const corEstado = ["coalesce", ["feature-state", "cor"], T];
    // zoom afastado: cidade pintada pela escala de cidades; aproximado: só cidades sem bairros
    const corMun = ["step", ["zoom"], ["coalesce", ["feature-state", "corMun"], T], ZOOM_BAIRROS, corEstado];
    const soBairros = (v) => ["step", ["zoom"], 0, ZOOM_BAIRROS, v];
    map.addLayer({ id: "mun-fill", type: "fill", source: "mun", paint: { "fill-color": corMun, "fill-opacity": 0.75 } }, primeiroSimbolo);
    map.addLayer({ id: "mun-hachura", type: "fill", source: "mun", filter: ["in", ["get", "CD_MUN"], ["literal", semBairros]], paint: { "fill-pattern": "hachura", "fill-opacity": soBairros(1) } }, primeiroSimbolo);
    map.addLayer({ id: "bai-fill", type: "fill", source: "bai", paint: { "fill-color": corEstado, "fill-opacity": soBairros(0.75) } }, primeiroSimbolo);
    map.addLayer({ id: "bai-linha", type: "line", source: "bai", paint: { "line-color": css("--contorno-bairro"), "line-opacity": soBairros(1), "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.3, 13, 1.2] } }, primeiroSimbolo);
    map.addLayer({ id: "mun-linha", type: "line", source: "mun", paint: { "line-color": css("--contorno-mun"), "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 8, 0.8, 11, 1.4], "line-opacity": 0.8 } }, primeiroSimbolo);
    map.addLayer({ id: "sel-linha", type: "line", source: "bai", filter: ["==", ["get", "CD_BAIRRO"], ""], paint: { "line-color": css("--text"), "line-width": 2.5 } });
    map.addLayer({ id: "sel-mun", type: "line", source: "mun", filter: ["==", ["get", "CD_MUN"], ""], paint: { "line-color": css("--text"), "line-width": 2.5 } });
    pintar();
  }

  function dicaMapa(e) {
    if (e.originalEvent.target.closest && e.originalEvent.target.closest(".maplibregl-popup")) { $("#dica").hidden = true; return; }
    const f = map.queryRenderedFeatures(e.point, { layers: ["bai-fill", "mun-fill"] });
    const dica = $("#dica");
    if (!f.length) { dica.hidden = true; map.getCanvas().style.cursor = ""; return; }
    map.getCanvas().style.cursor = "pointer";
    const cidades = nivelCidade();
    const b = cidades ? null : f.find((x) => x.layer.id === "bai-fill");
    const m = f.find((x) => x.layer.id === "mun-fill");
    const fmtv = (v) => (estado.medida === "total" ? fmt.format(v) + " casos" : textoTaxa(v));
    if (b) {
      const i = indice[b.properties.CD_BAIRRO];
      const a = D.areas[i];
      const v = i == null ? 0 : medida(valores.porArea[i], a.pop);
      const semTaxa = !a || !a.pop ? "bairro sem moradores no Censo" : "poucos moradores para a conta";
      dica.innerHTML = `<b>${b.properties.NM_BAIRRO}</b><span>${D.municipios[b.properties.CD_MUN].nome} · ${v == null ? semTaxa : fmtv(v)}</span>`;
    } else if (m) {
      const cd = m.properties.CD_MUN, mm = D.municipios[cd];
      if (mm.tem_bairros && !cidades) { dica.innerHTML = `<b>${mm.nome}</b><span>fora dos bairros mapeados</span>`; }
      else {
        const v = medida(valores.porMun[cd] || 0, mm.pop);
        dica.innerHTML = `<b>${mm.nome}</b><span>cidade inteira · ${v == null ? "–" : fmtv(v)}</span>`;
      }
    }
    posicionarDica(e.originalEvent.clientX, e.originalEvent.clientY);
  }

  function cliqueMapa(e) {
    const f = map.queryRenderedFeatures(e.point, { layers: ["bai-fill", "mun-fill"] });
    const cidades = nivelCidade();
    const b = cidades ? null : f.find((x) => x.layer.id === "bai-fill");
    const m = f.find((x) => x.layer.id === "mun-fill");
    $("#dica").hidden = true;
    const ponto = [e.lngLat.lng, e.lngLat.lat];
    if (b && indice[b.properties.CD_BAIRRO] != null) selecionar({ i: indice[b.properties.CD_BAIRRO], ponto });
    else if (m && (cidades || !D.municipios[m.properties.CD_MUN].tem_bairros)) selecionar({ mun: m.properties.CD_MUN, ponto });
    else selecionar(null);
  }

  let indice = {};

  function estilo() {
    return "https://tiles.openfreemap.org/styles/positron"; // sempre claro
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
    // ao cruzar o zoom dos bairros, legenda e ranking mudam de cidade <-> bairro
    let nivelAnterior = nivelCidade();
    map.on("moveend", () => {
      const agora = nivelCidade();
      if (agora !== nivelAnterior) { nivelAnterior = agora; legenda(); ranking(); }
      reescalarBairros();
    });
  }

  // ---------- controles ----------
  function marcarChips() {
    $("#categorias").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === estado.cat));
  }

  function escolherCategoria(id) {
    estado.cat = id;
    catIdx = D.categorias.findIndex((c) => c.id === id); // "todas" -> -1
    marcarChips();
    atualizar();
  }

  function montarControles() {
    // categorias: botões em chips (Todas + uma por categoria do stats.json)
    const chips = $("#categorias");
    chips.innerHTML = [`<button data-v="todas">Todas</button>`]
      .concat(D.categorias.map((c) => `<button data-v="${c.id}">${c.nome}</button>`)).join("");
    catIdx = D.categorias.findIndex((c) => c.id === estado.cat);
    marcarChips();
    chips.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) escolherCategoria(b.dataset.v);
    });

    const anos =[...new Set(D.meses.map((m) => m.slice(0, 4)))].reverse();
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
      const b = e.target.closest("button[data-i], button[data-mun]");
      if (!b) return;
      if (b.dataset.mun) selecionar({ mun: b.dataset.mun }, true);
      else selecionar({ i: +b.dataset.i }, true);
    });

    $("#alca").onclick = () => abrirPainel($("#painel").classList.contains("recolhido"));
    if (window.innerWidth <= 720) abrirPainel(false);

    montarBusca();
    const atual = new Date(D.atualizado_em);
    $("#nota-dados").textContent = `Dados de ${nomeMes(D.meses[0])} a ${nomeMes(ultimo)}, verificados em ${atual.toLocaleDateString("pt-BR")}.`;
  }

  // ---------- busca por cidade ou bairro ----------
  const semAcento = (t) => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  function montarBusca() {
    const itens = [];
    for (const [cd, m] of Object.entries(D.municipios)) itens.push({ tipo: "mun", cd, nome: m.nome, extra: "cidade", chave: semAcento(m.nome), peso: m.pop || 0 });
    D.areas.forEach((a, i) => {
      if (a.id.startsWith("?:") || a.id.startsWith("o:")) return;
      itens.push({ tipo: "bai", i, nome: a.nome, extra: D.municipios[a.mun].nome, chave: semAcento(a.nome), peso: a.pop || 0 });
    });
    const campo = $("#busca"), lista = $("#busca-lista");
    let achados = [], ativo = -1;

    const mostrar = () => {
      lista.innerHTML = achados.map((x, k) => `<li role="option" id="busca-${k}" aria-selected="${k === ativo}" class="${k === ativo ? "ativo" : ""}" data-k="${k}">
        <span>${x.nome}</span><small>${x.extra}</small></li>`).join("");
      lista.hidden = !achados.length;
      campo.setAttribute("aria-expanded", String(!!achados.length));
      if (ativo >= 0) campo.setAttribute("aria-activedescendant", "busca-" + ativo);
    };
    const escolher = (x) => {
      if (!x) return;
      campo.value = x.tipo === "mun" ? x.nome : `${x.nome}, ${x.extra}`;
      achados = []; mostrar(); campo.blur();
      if (x.tipo === "mun") selecionar({ mun: x.cd }, true);
      else selecionar({ i: x.i }, true);
    };
    campo.addEventListener("input", () => {
      const q = semAcento(campo.value.trim());
      ativo = -1;
      if (q.length < 2) { achados = []; mostrar(); return; }
      // começa com > contém; cidades antes de bairros; mais populosos primeiro
      achados = itens
        .map((x) => ({ x, r: x.chave.startsWith(q) ? 0 : x.chave.includes(" " + q) ? 1 : x.chave.includes(q) ? 2 : 9 }))
        .filter((o) => o.r < 9)
        .sort((p, q2) => p.r - q2.r || (p.x.tipo === "mun" ? 0 : 1) - (q2.x.tipo === "mun" ? 0 : 1) || q2.x.peso - p.x.peso)
        .slice(0, 8).map((o) => o.x);
      mostrar();
    });
    campo.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { ativo = Math.min(achados.length - 1, ativo + 1); mostrar(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { ativo = Math.max(0, ativo - 1); mostrar(); e.preventDefault(); }
      else if (e.key === "Enter") { escolher(achados[Math.max(0, ativo)]); e.preventDefault(); }
      else if (e.key === "Escape") { campo.value = ""; achados = []; mostrar(); }
    });
    lista.addEventListener("mousedown", (e) => { // mousedown: antes do blur do campo
      const li = e.target.closest("li[data-k]");
      if (li) { e.preventDefault(); escolher(achados[+li.dataset.k]); }
    });
    campo.addEventListener("blur", () => setTimeout(() => { achados = []; mostrar(); }, 150));
    campo.addEventListener("focus", () => { if (window.innerWidth <= 720) abrirPainel(true); }); // gaveta aberta para ver as sugestões
  }

  // ---------- início ----------
  Promise.all(["data/stats.json", "data/municipios.geojson", "data/bairros.geojson"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => r.json())))
    .then(([s, m, b]) => {
      D = s; mun = m; bai = b;
      D.areas.forEach((a, i) => { indice[a.id] = i; });
      for (const f of b.features) { const [[x0, y0], [x1, y1]] = caixa(f); centros[f.properties.CD_BAIRRO] = [(x0 + x1) / 2, (y0 + y1) / 2]; }
      for (const f of m.features) { const [[x0, y0], [x1, y1]] = caixa(f); centros[f.properties.CD_MUN] = [(x0 + x1) / 2, (y0 + y1) / 2]; }
      montarControles();
      atualizar();
      iniciarMapa();
    })
    .catch((err) => {
      document.body.insertAdjacentHTML("beforeend", `<p style="position:fixed;top:40%;width:100%;text-align:center">Não foi possível carregar os dados (${err.message}).</p>`);
    });
})();
