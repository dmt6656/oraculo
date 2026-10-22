# Ordem Paranormal — RPG de texto

Site em Flask (fichas, combate, chat, mural, catálogo de rituais).

## Rodar localmente

```bash
pip install -r requirements.txt
python app.py
```

Abre em http://localhost:5000. Na primeira execução é criada a conta `admin`
(senha `admin123`, ou o valor da variável `ADMIN_PASSWORD`). **Troque a senha.**

## Onde ficam os dados

Tudo que o site gera em uso fica na pasta `data/` (ao lado do `app.py`):

```
data/
├── rpg.db      banco de dados (jogadores, fichas, chat...)
└── static/     imagens enviadas (avatares, itens, mural, banners...)
```

Essa pasta **não vai para o GitHub** (está no `.gitignore`). Para guardar em
outro lugar (ex.: disco persistente da hospedagem), defina `RPG_DATA_DIR`.

## Variáveis de ambiente

| Variável         | Para quê                                              |
| ---------------- | ----------------------------------------------------- |
| `SECRET_KEY`     | chave das sessões (defina um valor longo e aleatório) |
| `ADMIN_PASSWORD` | senha da conta `admin` criada na 1ª execução          |
| `RPG_DATA_DIR`   | pasta do banco e das imagens enviadas                 |
| `RITUAIS_API_KEY`| chave da API de rituais (`/api/rituais`)              |
| `RPG_DEBUG`      | `1` liga o modo debug (só em desenvolvimento)         |

## Estrutura

```
app.py  database.py  ritual_catalog.py  fix_db.py  requirements.txt
templates/   páginas HTML
static/      CSS, JS, fontes, dados, ícones (ritual_icons_src/ tem os ícones dos rituais)
```

> GitHub só guarda o código. Para o site ficar no ar é preciso uma hospedagem
> que rode Python (Render, Railway, PythonAnywhere, VPS...) com disco persistente
> para `data/`.
