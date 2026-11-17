#!/usr/bin/env python3
"""Baixa os dados abertos de ocorrências da SSP-RS e gera web/data/stats.json.

Só usa a biblioteca padrão do Python (roda no GitHub Actions sem instalar nada).

Como funciona:
  1. Lê a página de dados abertos da SSP-RS e encontra os arquivos anuais de
     ocorrências (art. 3º da Lei 15.610/2021).
  2. Baixa só os arquivos novos. Cada republicação da SSP tem um nome novo,
     então um arquivo já baixado nunca muda.
  3. Filtra furto e roubo de celular nos municípios de config/regiao.json,
     identifica o bairro e soma por bairro x mês x tipo x dia/noite.
  4. Grava web/data/stats.json (lido pelo mapa) e data/relatorio_bairros.csv
     (nomes de bairro que não foram reconhecidos, para revisar).

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
TIPOS_VISTOS = Counter()


def tipo_celular(texto):
    """0 = furto, 1 = roubo, None = outro. Aceita variações como
    'FURTO DE TELEFONE CELULAR' (2021) e 'FURTO DE CELULAR' (2022+)."""
    if "CELULAR" not in texto:
        return None
    t = texto.strip()
    if t.startswith("FURTO"):
        TIPOS_VISTOS[t] += 1
        return 0
    if t.startswith("ROUBO"):
        TIPOS_VISTOS[t] += 1
        return 1
    return None
UA = {"User-Agent": "Mozilla/5.0 (compatible; mapa-furtos-celular/1.0)"}
# Colunas fixas do CSV (dicionário de dados da SSP)
COL_DATA, COL_HORA, COL_TIPO, COL_MUN, COL_BAIRRO = 1, 2, 4, 6, 8
SIMILARIDADE_MINIMA = 0.88


def norm(texto):
    """Maiúsculas, sem acento, sem pontuação, espaços simples."""
    t = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode()
    t = re.sub(r"[^A-Za-z0-9 ]+", " ", t.upper())
    return re.sub(r"\s+", " ", t).strip()


PREFIXOS = ("BAIRRO ", "B ", "LOTEAMENTO ", "LOT ")


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
        for cd, b in ref["bairros"].items():
            self.por_mun[b["mun"]][norm(b["nome"])] = cd
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
        parecido = difflib.get_close_matches(sem_prefixo(n), oficiais.keys(), n=1, cutoff=SIMILARIDADE_MINIMA)
        if parecido:
            return oficiais[parecido[0]], "parecido"
        return "?:" + cd_mun, "nao_encontrado"


def processar(arquivos, ref, bairros):
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
                tipo = tipo_celular(linha[COL_TIPO])
                if tipo is None:
                    continue
                cd_mun = mun_por_nome.get(norm(linha[COL_MUN]))
                if cd_mun is None:
                    continue
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
                contagem[mes][(area, tipo, noite)] += 1
        if not contagem:
            print("aviso: nenhuma ocorrência de celular em", local)
            continue
        for mes, c in contagem.items():
            por_mes[mes] = c
        print("processado", local, "meses:", min(contagem), "a", max(contagem), flush=True)
    print("tipos considerados:", dict(TIPOS_VISTOS))
    return por_mes


def titulo(nome_norm):
    minusculas = {"DA", "DE", "DO", "DAS", "DOS", "E"}
    return " ".join(p.lower() if p in minusculas else p.capitalize() for p in nome_norm.split())


def montar_saida(por_mes, ref, arquivos):
    meses = sorted(por_mes)
    areas = {}  # id -> info
    for cd, b in ref["bairros"].items():
        areas[cd] = {"nome": b["nome"], "mun": b["mun"], "pop": b["pop"], "geo": True}
    linhas = []
    usados = set()
    for i, mes in enumerate(meses):
        for (area, tipo, noite), n in sorted(por_mes[mes].items()):
            usados.add(area)
            linhas.append((area, i, tipo, noite, n))
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
        "areas": [dict(id=a, **areas[a]) for a in ids],
        # [área, mês, tipo (0 furto / 1 roubo), noite (0/1), ocorrências]
        "linhas": [[indice[a], m, t, nt, n] for a, m, t, nt, n in linhas],
    }


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
    bairros = Bairros(ref, aliases)
    por_mes = processar(arquivos, ref, bairros)
    saida = montar_saida(por_mes, ref, arquivos)

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


if __name__ == "__main__":
    sys.exit(main())
