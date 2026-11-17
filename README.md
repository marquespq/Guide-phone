# Furtos de celular — Grande Porto Alegre

Mapa de furtos e roubos de celular registrados por bairro nos 29 municípios
da concentração urbana de Porto Alegre (IBGE), com dados abertos da SSP-RS.

- Filtros: furto/roubo, dia/noite (18h–6h), período, cidade.
- Medidas: ocorrências ou ocorrências por mil moradores (população do Censo 2022).
- Clique num bairro: total, taxa, participação na cidade e série mensal.
- Gravataí e Cachoeirinha usam os contornos oficiais de bairro das prefeituras
  (`data/ref/bairros_prefeituras/`), porque o IBGE não tem bairros dessas cidades. Os nomes vieram do
  portal de geoprocessamento de cada prefeitura (login "Acesso Público"). A população desses bairros é
  estimada somando os setores censitários do Censo 2022 cujo ponto central cai dentro de cada bairro
  (bate 99,8% com a população de Gravataí e 97,9% com a de Cachoeirinha).
- Cidades ainda sem mapa de bairros (Alvorada, Sapucaia do Sul, Campo Bom e menores) aparecem
  hachuradas. Ao clicar, mostram a lista de bairros como foram escritos no registro policial.

## Estrutura

```
config/regiao.json          municípios da região (edite para incluir/remover)
config/aliases.json         grafias da SSP -> nome oficial do bairro
scripts/build_geo.py        contornos + população (roda só quando a região muda)
scripts/update_data.py      baixa a SSP e gera web/data/stats.json (roda todo mês)
data/ref/referencia.json    nomes, códigos e população (gerado por build_geo.py)
data/relatorio_bairros.csv  como cada grafia de bairro foi tratada
web/                        o site estático (é isso que vai para o GitHub Pages)
```

## Rodar localmente

```bash
python3 scripts/update_data.py        # baixa/atualiza os dados (~150 MB na 1ª vez)
cd web && python3 -m http.server 8000 # abra http://localhost:8000
```

`update_data.py` só usa a biblioteca padrão do Python. `build_geo.py` precisa de Node
(usa `npx mapshaper`) e só é necessário se você mudar `config/regiao.json`.

## Atualização automática

A workflow `.github/workflows/atualizar-e-publicar.yml`:

1. **Toda segunda às 9h** baixa os arquivos da SSP-RS. Só baixa de novo os que mudaram,
   porque a SSP republica com outro nome.
2. Regera `web/data/stats.json`. Se algo mudou, faz commit e publica no GitHub Pages.
3. Também pode ser disparada à mão: aba **Actions → Atualizar dados e publicar → Run workflow**.

Se a SSP mudar o layout da página, o script falha com uma mensagem clara e o GitHub
manda um e-mail de falha da workflow.

### Configurar no GitHub (uma vez)

1. Crie o repositório e faça o push.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Actions → Atualizar dados e publicar → Run workflow** para a primeira publicação.

## Melhorando a identificação de bairros

Depois de cada atualização, `data/relatorio_bairros.csv` lista cada grafia vista e como
foi tratada (`exato`, `alias`, `parecido`, `nome`, `nao_encontrado`, `vazio`). Para
corrigir uma grafia `nao_encontrado`, acrescente em `config/aliases.json`:

```json
"Porto Alegre": { "GRAFIA DA SSP": "Nome Oficial do Bairro" }
```

Os bairros antigos de POA (Marcílio Dias, Protásio Alves, São José, Jardim Itu Sabará)
ficam como "não identificado" de propósito, porque foram divididos pela Lei 12.112/2016.

## Limitações

- A SSP publica o bairro, não o endereço exato. Não dá para mostrar ruas ou pontos.
- São só os casos registrados em boletim de ocorrência.
- Bairros centrais e comerciais concentram registros também porque circula mais gente.
  A taxa por morador não é calculada para bairros com menos de 3 mil moradores.

## Fontes

- Ocorrências: [SSP-RS — Dados Abertos (Lei 15.610/2021)](https://ssp.rs.gov.br/dados-abertos)
- Bairros, municípios e população: IBGE, Censo 2022 e Malha Municipal 2024
- Mapa base: [OpenFreeMap](https://openfreemap.org) © OpenStreetMap
