#!/usr/bin/env python3
"""Monta os contornos (municípios e bairros) e a população da região.

Roda raramente: só quando a lista de municípios em config/regiao.json mudar
ou quando o IBGE publicar malhas novas. Precisa de Node (usa mapshaper via npx).

Saídas:
  web/data/municipios.geojson   contornos dos municípios da região
  web/data/bairros.geojson      contornos dos bairros oficiais (IBGE Censo 2022)
  data/ref/referencia.json      nomes, códigos e população, lido por update_data.py
"""
import csv
import io
import json
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "ibge"
WEB_DATA = ROOT / "web" / "data"
REF = ROOT / "data" / "ref"

IBGE = "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais"
CENSO = "https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/Agregados_por_Setores_Censitarios"
FONTES = {
    "bairros_shp": IBGE + "/malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/bairros/shp/UF/RS_bairros_CD2022.zip",
    "municipios_shp": IBGE + "/malhas_municipais/municipio_2024/UFs/RS/RS_Municipios_2024.zip",
    "pop_bairros": CENSO + "/Agregados_por_Bairro_csv/Agregados_por_bairros_basico_BR_20260520.zip",
    "pop_municipios": CENSO + "/Agregados_por_Municipio_csv/Agregados_por_municipios_basico_BR_20260520.zip",
    # setores censitários com população, para estimar bairros das prefeituras
    "setores_shp": CENSO + "/malha_com_atributos/setores/shp/UF/RS/RS_setores_CD2022.zip",
}
MAPSHAPER = ["npx", "-y", "mapshaper@0.6.102"]
MIN_BAIRROS = 3


def baixar(nome, url):
    RAW.mkdir(parents=True, exist_ok=True)
    destino = RAW / (nome + ".zip")
    if not destino.exists():
        print("baixando", url)
        req = urllib.request.Request(url, headers={"User-Agent": "mapa-furtos-celular/1.0"})
        with urllib.request.urlopen(req, timeout=300) as r, open(destino, "wb") as f:
            f.write(r.read())
    return destino


def extrair(zip_path):
    pasta = zip_path.with_suffix("")
    if not pasta.exists():
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(pasta)
    return pasta


def ler_csv_ibge(zip_path, codigos_mun):
    """Lê um CSV de agregados do IBGE dentro do zip, filtrando pelos municípios."""
    with zipfile.ZipFile(zip_path) as z:
        nome = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        with z.open(nome) as f:
            leitor = csv.DictReader(io.TextIOWrapper(f, encoding="latin1"), delimiter=";")
            return [r for r in leitor if r["CD_MUN"] in codigos_mun]


def inteiro(valor):
    try:
        return int(str(valor).replace(".", "").strip())
    except ValueError:
        return None


def mapshaper(*args):
    subprocess.run(MAPSHAPER + list(args), check=True)


def estimar_populacao(bairros_geojson, setores_zip):
    """População de bairros que não são do IBGE (ex.: malha da prefeitura).

    Cada setor censitário do Censo 2022 vira um ponto interno; somamos a
    população (v0001) dos setores cujo ponto cai dentro de cada bairro.
    Setores são pequenos em área urbana, então o erro é pequeno.
    """
    shp = next(extrair(setores_zip).glob("*.shp"))
    feats = json.loads(Path(bairros_geojson).read_text(encoding="utf-8"))["features"]
    muns = sorted({f["properties"]["CD_MUN"] for f in feats})
    filtro = "[%s].indexOf(CD_SETOR.substr(0, 7)) > -1" % ",".join("'%s'" % m for m in muns)
    pontos = RAW / ("setores_pontos_%s.geojson" % "_".join(muns))
    mapshaper("-i", str(shp), "encoding=utf8", "-filter", filtro,
              "-filter-fields", "CD_SETOR,v0001", "-points", "inner",
              "-o", str(pontos), "format=geojson")
    saida = RAW / ("pop_" + Path(bairros_geojson).name)
    mapshaper("-i", str(bairros_geojson), "-join", str(pontos), "calc=POP=sum(v0001)",
              "-filter-fields", "CD_BAIRRO,POP", "-o", str(saida), "format=geojson")
    resultado = {}
    for f in json.loads(saida.read_text(encoding="utf-8"))["features"]:
        resultado[f["properties"]["CD_BAIRRO"]] = inteiro(f["properties"].get("POP") or 0)
    return resultado


def main():
    regiao = json.loads((ROOT / "config" / "regiao.json").read_text(encoding="utf-8"))
    codigos = [m["cd"] for m in regiao["municipios"]]
    filtro = "[%s].indexOf(CD_MUN) > -1" % ",".join("'%s'" % c for c in codigos)

    zips = {k: baixar(k, u) for k, u in FONTES.items()}
    shp_bairros = next(extrair(zips["bairros_shp"]).glob("*.shp"))
    shp_mun = next(extrair(zips["municipios_shp"]).glob("*.shp"))

    WEB_DATA.mkdir(parents=True, exist_ok=True)
    mapshaper(
        "-i", str(shp_mun), "encoding=utf8",
        "-filter", filtro,
        "-filter-fields", "CD_MUN",
        "-simplify", "8%", "keep-shapes",
        "-o", str(WEB_DATA / "municipios.geojson"), "format=geojson", "precision=0.00001",
    )
    mapshaper(
        "-i", str(shp_bairros), "encoding=utf8",
        "-filter", filtro,
        "-filter-fields", "CD_BAIRRO,NM_BAIRRO,CD_MUN",
        "-simplify", "15%", "keep-shapes",
        "-o", str(WEB_DATA / "bairros.geojson"), "format=geojson", "precision=0.00001",
    )

    pop_mun = {r["CD_MUN"]: r for r in ler_csv_ibge(zips["pop_municipios"], set(codigos))}
    pop_bai = {r["CD_BAIRRO"]: r for r in ler_csv_ibge(zips["pop_bairros"], set(codigos))}

    bairros_geo = json.loads((WEB_DATA / "bairros.geojson").read_text(encoding="utf-8"))

    # Bairros oficiais das prefeituras para cidades que o IBGE não cobre
    # (data/ref/bairros_prefeituras/*.geojson, campos CD_BAIRRO, NM_BAIRRO, CD_MUN).
    # Eles substituem o que o IBGE tiver para o mesmo município.
    pref_dir = ROOT / "data" / "ref" / "bairros_prefeituras"
    pop_estimada = {}
    for arq in sorted(pref_dir.glob("*.geojson")):
        tmp = RAW / ("pref_" + arq.name)
        mapshaper("-i", str(arq), "-simplify", "15%", "keep-shapes",
                  "-o", str(tmp), "format=geojson", "precision=0.00001")
        extra = json.loads(tmp.read_text(encoding="utf-8"))["features"]
        pop_estimada.update(estimar_populacao(arq, zips["setores_shp"]))
        muns = {f["properties"]["CD_MUN"] for f in extra} & set(codigos)
        bairros_geo["features"] = [f for f in bairros_geo["features"] if f["properties"]["CD_MUN"] not in muns]
        bairros_geo["features"] += [f for f in extra if f["properties"]["CD_MUN"] in muns]
        print("bairros da prefeitura:", arq.name, len(extra))

    # Cidade com menos de MIN_BAIRROS bairros na malha (ex.: Campo Bom tem 1)
    # não tem divisão útil: tratamos como "sem malha de bairros".
    por_mun = {}
    for feat in bairros_geo["features"]:
        por_mun[feat["properties"]["CD_MUN"]] = por_mun.get(feat["properties"]["CD_MUN"], 0) + 1
    bairros_geo["features"] = [
        f for f in bairros_geo["features"] if por_mun[f["properties"]["CD_MUN"]] >= MIN_BAIRROS
    ]
    (WEB_DATA / "bairros.geojson").write_text(
        json.dumps(bairros_geo, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    bairros = {}
    for feat in bairros_geo["features"]:
        p = feat["properties"]
        info = pop_bai.get(p["CD_BAIRRO"], {})
        pop = inteiro(info.get("v0001"))
        if pop is None:
            pop = pop_estimada.get(p["CD_BAIRRO"])
        bairros[p["CD_BAIRRO"]] = {
            "nome": p["NM_BAIRRO"],
            "mun": p["CD_MUN"],
            "pop": pop,
            "pop_estimada": p["CD_BAIRRO"] in pop_estimada,
        }

    municipios = {}
    for m in regiao["municipios"]:
        info = pop_mun.get(m["cd"], {})
        municipios[m["cd"]] = {
            "nome": m["nome"],
            "pop": inteiro(info.get("v0001")),
            "tem_bairros": any(b["mun"] == m["cd"] for b in bairros.values()),
        }

    REF.mkdir(parents=True, exist_ok=True)
    ref = {"regiao": regiao["nome"], "municipios": municipios, "bairros": bairros}
    (REF / "referencia.json").write_text(json.dumps(ref, ensure_ascii=False, indent=1), encoding="utf-8")

    com = [v["nome"] for v in municipios.values() if v["tem_bairros"]]
    sem = [v["nome"] for v in municipios.values() if not v["tem_bairros"]]
    print("%d bairros em %d municípios" % (len(bairros), len(com)))
    print("sem malha de bairros no IBGE:", ", ".join(sem) or "nenhum")


if __name__ == "__main__":
    sys.exit(main())
