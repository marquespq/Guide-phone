#!/usr/bin/env python3
"""Baixa os dados abertos de ocorrências da SSP-RS e gera web/data/stats.json.

Só usa a biblioteca padrão do Python (roda no GitHub Actions sem instalar nada).

Como funciona:
  1. Lê a página de dados abertos da SSP-RS e encontra os arquivos anuais de
     ocorrências (art. 3º da Lei 15.610/2021).
  2. Baixa só os arquivos novos. Cada republicação da SSP tem um nome novo,
     então um arquivo já baixado nunca muda.
  3. Filtra os furtos e roubos das categorias de config/categorias.json nos
     municípios de config/regiao.json, identifica o bairro e soma por
     bairro x mês x categoria x furto/roubo x dia/noite.
  4. Grava web/data/stats.json (lido pelo mapa), data/relatorio_bairros.csv
     (como cada grafia de bairro foi tratada) e data/relatorio_tipos.csv
     (tipos de crime usados e os que ficaram de fora).

Uso:  python3 scripts/update_data.py
"""
import csv
import datetime as dt
import difflib
import io
import json
import re
import sys
import unicodedata
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "ssp"
PAGINA = "https://ssp.rs.gov.br/dados-abertos"
BASE = "https://ssp.rs.gov.br"
class Classificador:
    """Liga o 'Tipo Enquadramento' da SSP a uma categoria de config/categorias.json.

    Devolve (indice_categoria, 0 furto / 1 roubo) ou None se o tipo não entra no mapa.
    Guarda os tipos de furto/roubo que ficaram de fora para o relatório.
    """

    def __init__(self, config):
        self.categorias = config["categorias"]
        self.mapa = {}
        for i, cat in enumerate(self.categorias):
            for t in cat["tipos"]:
                self.mapa[norm(t)] = i
        self.usados = Counter()
        self.fora = Counter()
        self.cache = {}

    def __call__(self, texto):
        if texto not in self.cache:
            n = norm(texto)
            cat = self.mapa.get(n)
            furto_roubo = 0 if n.startswith("FURTO") else 1
            self.cache[texto] = (n, None if cat is None else (cat, furto_roubo))
        n, r = self.cache[texto]
        if r is None:
            if n.startswith(("FURTO", "ROUBO")):
                self.fora[n] += 1
        else:
            self.usados[n] += 1
        return r


UA = {"User-Agent": "Mozilla/5.0 (compatible; mapa-furtos-roubos/1.0)"}
# Colunas fixas do CSV (dicionário de dados da SSP)
COL_DATA, COL_HORA, COL_TIPO, COL_MUN, COL_BAIRRO = 1, 2, 4, 6, 8
SIMILARIDADE_MINIMA = 0.88


def norm(texto):
    """Maiúsculas, sem acento, sem pontuação, espaços simples."""
    t = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode()
    t = re.sub(r"[^A-Za-z0-9 ]+", " ", t.upper())
    return re.sub(r"\s+", " ", t).strip()


PREFIXOS = ("BAIRRO ", "B ", "LOTEAMENTO ", "LOT ", "VILA ", "VL ", "PARQUE ", "JARDIM ", "RES ", "RESIDENCIAL ")


def sem_prefixo(nome):
    for p in PREFIXOS:
        if nome.startswith(p):
            return nome[len(p):]
    return nome


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


def listar_arquivos():
    """Links dos arquivos anuais de ocorrências na página da SSP."""
    html = get(PAGINA).decode("utf-8", "replace")
    links = re.findall(r'href="(/upload/arquivos/(\d{6})/([^"]+\.(?:zip|csv)))"', html)
    arquivos = {}
    for caminho, pasta, nome in links:
        n = nome.lower()
        if "art-6" in n or "semestre" in n:  # publicação semestral (outro conteúdo)
            continue
        if "ocorrencias" in n or "janeiro-a-dezembro" in n:
            # pasta (AAAAMM) + nome = ordem cronológica de publicação
            arquivos[pasta + "-" + nome] = BASE + caminho
    if not arquivos:
        raise SystemExit("Nenhum arquivo encontrado em %s. O layout da página mudou?" % PAGINA)
    return arquivos


def sincronizar(arquivos):
    RAW.mkdir(parents=True, exist_ok=True)
    for local, url in sorted(arquivos.items()):
        destino = RAW / local
        if destino.exists():
            continue
        print("baixando", url, flush=True)
        tmp = destino.with_suffix(".parcial")
        tmp.write_bytes(get(url))
        tmp.rename(destino)
    # remove cópias antigas que a SSP já substituiu
    for f in RAW.iterdir():
        if f.name not in arquivos:
            f.unlink()


def abrir_csv(caminho):
    if caminho.suffix == ".zip":
        z = zipfile.ZipFile(caminho)
        nome = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        return io.TextIOWrapper(z.open(nome), encoding="latin1", newline="")
    return open(caminho, encoding="latin1", newline="")


class Bairros:
    """Liga o texto livre de bairro da SSP ao bairro oficial do IBGE."""

    def __init__(self, ref, aliases):
        self.por_mun = defaultdict(dict)  # cd_mun -> {nome_norm: cd_bairro}
        # mesmo índice, mas sem prefixo (VILA, PARQUE...) dos dois lados;
        # só vale quando o nome sem prefixo é único na cidade
        self.sem_prefixo = defaultdict(dict)
        repetidos = set()
        for cd, b in ref["bairros"].items():
            n = norm(b["nome"])
            self.por_mun[b["mun"]][n] = cd
            chave = (b["mun"], sem_prefixo(n))
            if chave in repetidos:
                continue
            if sem_prefixo(n) in self.sem_prefixo[b["mun"]]:
                del self.sem_prefixo[b["mun"]][sem_prefixo(n)]
                repetidos.add(chave)
            else:
                self.sem_prefixo[b["mun"]][sem_prefixo(n)] = cd
        self.aliases = {}
        for mun_nome, mapa in aliases.items():
            if mun_nome.startswith("_"):
                continue
            cd_mun = next((c for c, m in ref["municipios"].items() if norm(m["nome"]) == norm(mun_nome)), None)
            if cd_mun is None:
                print("aviso: município do aliases.json não está na região:", mun_nome)
                continue
            for de, para in mapa.items():
                self.aliases[(cd_mun, norm(de))] = para
        self.cache = {}
        self.como = Counter()  # (cd_mun, texto_norm, resultado, metodo) -> n

    def identificar(self, cd_mun, texto, tem_geo):
        chave = (cd_mun, texto)
        if chave not in self.cache:
            self.cache[chave] = self._identificar(cd_mun, norm(texto), tem_geo)
        resultado, metodo = self.cache[chave]
        self.como[(cd_mun, norm(texto), resultado, metodo)] += 1
        return resultado

    def _identificar(self, cd_mun, n, tem_geo):
        if not n:
            return "?:" + cd_mun, "vazio"
        if (cd_mun, n) in self.aliases:
            destino = self.aliases[(cd_mun, n)]
            if destino is None:
                return "?:" + cd_mun, "alias"
            if not tem_geo:
                return "x:%s:%s" % (cd_mun, norm(destino)), "alias"
            cd = self.por_mun[cd_mun].get(norm(destino))
            if cd:
                return cd, "alias"
            print("aviso: alias aponta para bairro inexistente:", destino)
        if not tem_geo:
            # cidade sem malha de bairros: agrupa só pelo nome padronizado
            return "x:%s:%s" % (cd_mun, sem_prefixo(n)), "nome"
        oficiais = self.por_mun[cd_mun]
        for candidato in (n, sem_prefixo(n)):
            if candidato in oficiais:
                return oficiais[candidato], "exato"
        if sem_prefixo(n) in self.sem_prefixo[cd_mun]:
            return self.sem_prefixo[cd_mun][sem_prefixo(n)], "exato"
        parecido = difflib.get_close_matches(sem_prefixo(n), oficiais.keys(), n=1, cutoff=SIMILARIDADE_MINIMA)
        if parecido:
            return oficiais[parecido[0]], "parecido"
        return "?:" + cd_mun, "nao_encontrado"


def processar(arquivos, ref, bairros, classificar):
    mun_por_nome = {norm(m["nome"]): cd for cd, m in ref["municipios"].items()}
    # mês -> (arquivo mais recente que tem esse mês, contagens)
    por_mes = {}
    for local in sorted(arquivos):  # ordem de publicação: o mais novo sobrescreve
        contagem = defaultdict(Counter)
        with abrir_csv(RAW / local) as f:
            leitor = csv.reader(f, delimiter=";")
            next(leitor)
            for linha in leitor:
                if len(linha) <= COL_BAIRRO:
                    continue
                cd_mun = mun_por_nome.get(norm(linha[COL_MUN]))
                if cd_mun is None:
                    continue
                classe = classificar(linha[COL_TIPO])
                if classe is None:
                    continue
                cat, tipo = classe
                d = linha[COL_DATA].strip()
                if len(d) != 10:
                    continue
                mes = d[6:10] + "-" + d[3:5]
                try:
                    hora = int(linha[COL_HORA][:2])
                except ValueError:
                    hora = 12
                noite = 1 if (hora >= 18 or hora < 6) else 0
                tem_geo = ref["municipios"][cd_mun]["tem_bairros"]
                area = bairros.identificar(cd_mun, linha[COL_BAIRRO].strip(), tem_geo)
                contagem[mes][(area, cat, tipo, noite)] += 1
        if not contagem:
            print("aviso: nenhuma ocorrência da região em", local)
            continue
        for mes, c in contagem.items():
            por_mes[mes] = c
        print("processado", local, "meses:", min(contagem), "a", max(contagem), flush=True)
    return por_mes


def titulo(nome_norm):
    minusculas = {"DA", "DE", "DO", "DAS", "DOS", "E"}
    romanos = {"II", "III", "IV"}
    return " ".join(p.lower() if p in minusculas else p if p in romanos else p.capitalize() for p in nome_norm.split())


def montar_saida(por_mes, ref, arquivos, categorias):
    meses = sorted(por_mes)
    areas = {}  # id -> info
    for cd, b in ref["bairros"].items():
        areas[cd] = {"nome": b["nome"], "mun": b["mun"], "pop": b["pop"], "geo": True}
        if b.get("pop_estimada"):
            areas[cd]["pop_est"] = True  # somada dos setores do Censo (bairro da prefeitura)
    linhas = []
    usados = set()
    for i, mes in enumerate(meses):
        for (area, cat, tipo, noite), n in sorted(por_mes[mes].items()):
            usados.add(area)
            linhas.append((area, i, cat, tipo, noite, n))
    for area in usados:
        if area in areas:
            continue
        if area.startswith("?:"):
            areas[area] = {"nome": "Bairro não informado", "mun": area[2:], "pop": None, "geo": False}
        else:
            _, cd_mun, nome = area.split(":", 2)
            areas[area] = {"nome": titulo(nome), "mun": cd_mun, "pop": None, "geo": False}
    ids = sorted(areas, key=lambda a: (areas[a]["mun"], a))
    indice = {a: i for i, a in enumerate(ids)}
    return {
        "regiao": ref["regiao"],
        "atualizado_em": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fonte": PAGINA,
        "arquivos": sorted(arquivos),
        "meses": meses,
        "municipios": ref["municipios"],
        "categorias": [{"id": c["id"], "nome": c["nome"], "descricao": c["descricao"]} for c in categorias],
        "areas": [dict(id=a, **areas[a]) for a in ids],
        # [área, mês, categoria, tipo (0 furto / 1 roubo), noite (0/1), ocorrências]
        "linhas": [[indice[a], m, c, t, nt, n] for a, m, c, t, nt, n in linhas],
    }


def gravar_relatorio_tipos(classificar, categorias):
    """Tipos usados em cada categoria e tipos de furto/roubo que ficaram de fora."""
    caminho = ROOT / "data" / "relatorio_tipos.csv"
    with open(caminho, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["tipo_ssp", "ocorrencias_na_regiao", "categoria"])
        for t, n in classificar.usados.most_common():
            w.writerow([t, n, categorias[classificar.mapa[t]]["nome"]])
        for t, n in classificar.fora.most_common():
            w.writerow([t, n, "(fora do mapa)"])
    print("tipos usados: %d (%d ocorrências) | furtos/roubos fora: %d tipos (%d ocorrências)" % (
        len(classificar.usados), sum(classificar.usados.values()),
        len(classificar.fora), sum(classificar.fora.values())))


def gravar_relatorio(bairros, ref):
    """CSV com cada grafia vista e como foi tratada, para revisar aliases."""
    nomes_mun = {cd: m["nome"] for cd, m in ref["municipios"].items()}
    nomes_bai = {cd: b["nome"] for cd, b in ref["bairros"].items()}
    caminho = ROOT / "data" / "relatorio_bairros.csv"
    with open(caminho, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["municipio", "bairro_ssp", "ocorrencias", "metodo", "bairro_mapa"])
        itens = sorted(bairros.como.items(), key=lambda kv: (nomes_mun[kv[0][0]], -kv[1]))
        for (cd_mun, texto, resultado, metodo), n in itens:
            destino = nomes_bai.get(resultado) or (titulo(resultado.split(":", 2)[2]) if resultado.startswith("x:") else "")
            w.writerow([nomes_mun[cd_mun], texto, n, metodo, destino])
    total = sum(bairros.como.values())
    for metodo in ("exato", "alias", "parecido", "nome", "nao_encontrado", "vazio"):
        n = sum(v for k, v in bairros.como.items() if k[3] == metodo)
        print("  %-15s %6d  (%.1f%%)" % (metodo, n, 100.0 * n / total))


def main():
    ref = json.loads((ROOT / "data" / "ref" / "referencia.json").read_text(encoding="utf-8"))
    aliases = json.loads((ROOT / "config" / "aliases.json").read_text(encoding="utf-8"))
    arquivos = listar_arquivos()
    sincronizar(arquivos)
    config_cat = json.loads((ROOT / "config" / "categorias.json").read_text(encoding="utf-8"))
    classificar = Classificador(config_cat)
    bairros = Bairros(ref, aliases)
    por_mes = processar(arquivos, ref, bairros, classificar)
    saida = montar_saida(por_mes, ref, arquivos, config_cat["categorias"])

    destino = ROOT / "web" / "data" / "stats.json"
    novo = json.dumps(saida, ensure_ascii=False, separators=(",", ":"))
    antigo = destino.read_text(encoding="utf-8") if destino.exists() else ""
    # só regrava se os dados mudaram (ignora o carimbo de data)
    tira_data = lambda s: re.sub(r'"atualizado_em":"[^"]*"', "", s)
    if tira_data(novo) != tira_data(antigo):
        destino.write_text(novo, encoding="utf-8")
        print("stats.json atualizado: %d meses (%s a %s), %d linhas" % (
            len(saida["meses"]), saida["meses"][0], saida["meses"][-1], len(saida["linhas"])))
    else:
        print("sem mudanças nos dados")
    gravar_relatorio(bairros, ref)
    gravar_relatorio_tipos(classificar, config_cat["categorias"])


if __name__ == "__main__":
    sys.exit(main())
