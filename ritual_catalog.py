"""Catálogo de rituais (sistema auxiliar).

Um catálogo COMPARTILHADO: o mestre (ou uma API externa, via chave) cadastra
rituais uma vez; qualquer jogador busca e copia o ritual para a própria ficha.

Ligado ao app com uma única linha no app.py (veja o final do arquivo):
    ritual_catalog.register(app, ...)

API (JSON):
    GET    /api/rituais?q=&elemento=&circulo=&limit=&offset=   busca (login ou chave)
    GET    /api/rituais/<id>                                   um ritual
    POST   /api/rituais            objeto ou lista             cadastra (mestre ou chave)
    PUT    /api/rituais/<id>                                   edita   (mestre ou chave)
    DELETE /api/rituais/<id>                                   exclui  (mestre ou chave)
    POST   /api/rituais/<id>/adicionar   {"user_id": N}        copia p/ ficha (login)

Formatos aceitos no POST/PUT (os dois valem, inclusive misturados):
  - inglês  : name, element, circle, execution, range, target, duration, resistance,
              effect_summary, pe_cost_discente, description_discente, ...
  - português (JSON do livro): nome, elemento, circulo, execucao, alcance, alvo, duracao,
              resistencia, descricao, discente{custo_pe, efeito}, verdadeiro{custo_pe, efeito},
              requisitos{discente, verdadeiro}

Acesso por API externa: defina a variável de ambiente RITUAIS_API_KEY e envie
o cabeçalho  X-API-Key: <chave>  (vale para leitura e escrita).
"""
import hmac
import io
from datetime import datetime
import json
import os
import re
import sqlite3
import unicodedata

from flask import jsonify, redirect, render_template, request, send_file, session, url_for
from werkzeug.datastructures import FileStorage

TEXT_FIELDS = (
    'execution', 'range', 'target', 'duration', 'resistance',
    'effect_summary', 'description_discente', 'description_verdadeira',
)
MAX_TEXT = 4000

# No formato em português, discente.custo_pe / verdadeiro.custo_pe é o custo ADICIONAL
# (como no livro: "Discente +2 PE"). O app guarda e desconta o custo TOTAL da versão,
# então na importação soma-se o custo do círculo. Se o seu JSON já traz o total,
# troque para False.
CUSTO_PT_E_ADICIONAL = True

PT_KEYS = {
    'nome': 'name', 'elemento': 'element', 'circulo': 'circle', 'execucao': 'execution',
    'alcance': 'range', 'alvo': 'target', 'duracao': 'duration', 'resistencia': 'resistance',
    'descricao': 'effect_summary',
}


def _norm(text):
    """minúsculas e sem acento — para busca e comparação de nomes."""
    text = unicodedata.normalize('NFD', str(text or '').strip().lower())
    return ''.join(c for c in text if unicodedata.category(c) != 'Mn')


def _from_pt(data):
    """Converte um ritual no formato em português para as chaves usadas internamente."""
    out = dict(data)
    for pt, en in PT_KEYS.items():
        if pt in out and en not in out:
            out[en] = out.pop(pt)
    for pt_key, suffix in (('discente', 'discente'), ('verdadeiro', 'verdadeira')):
        block = out.pop(pt_key, None)
        if isinstance(block, dict):
            if block.get('custo_pe') is not None:
                out.setdefault('_add_' + suffix, block['custo_pe'])
            if block.get('efeito'):
                out.setdefault('description_' + suffix, block['efeito'])
    req = out.pop('requisitos', None)
    if isinstance(req, dict):
        for pt_key, suffix in (('discente', 'discente'), ('verdadeiro', 'verdadeira')):
            if req.get(pt_key):
                out['_req_' + suffix] = req[pt_key]
    return out


# ---------------------------------------------------------------------------
# Ícones dos rituais: cache sob demanda
# ---------------------------------------------------------------------------
# Os arquivos-fonte ficam em static/ritual_icons_src/ (pasta de código, atualizável).
# Nada é copiado antecipadamente: a versão leve (branca, 256 px, WebP) só é gerada
# na primeira vez que alguém pede aquele ícone, e fica guardada em cache.
ICON_SIZE = 256
ICON_EXTS = ('.png', '.webp', '.jpg', '.jpeg')


def _slug(text):
    """\"Controle Mental (Emissão)\" -> \"controle-mental-emissao\"."""
    return re.sub(r'[^a-z0-9]+', '-', _norm(text)).strip('-')


def _slug_from_filename(filename):
    stem = os.path.splitext(filename)[0]
    return _slug(re.sub(r'\s+em\s+preto$', '', stem.strip(), flags=re.I))


def _build_icon_index(src_dir):
    """{slug: caminho}. Se houver versão branca e \"em Preto\", usa a branca."""
    index, black = {}, {}
    try:
        names = os.listdir(src_dir)
    except OSError:
        return index
    for fn in sorted(names):
        if not fn.lower().endswith(ICON_EXTS):
            continue
        is_black = bool(re.search(r'\s+em\s+preto\.[a-z]+$', fn, flags=re.I))
        (black if is_black else index).setdefault(_slug_from_filename(fn), os.path.join(src_dir, fn))
    for slug, path in black.items():
        index.setdefault(slug, path)
    return index


# Nomes digitados errados que já podem estar no banco -> nome correto.
# É aplicado sozinho na inicialização (idempotente) no catálogo e nas fichas.
NAME_FIXES = {
    'Fortalececimento Sensorial': 'Fortalecimento Sensorial',
    'Odiar Incontrolável': 'Ódio Incontrolável',
}


def _fix_ritual_names(conn):
    for old, new in NAME_FIXES.items():
        try:
            conn.execute(
                'UPDATE ritual_catalog SET name = ? WHERE name = ? '
                'AND NOT EXISTS (SELECT 1 FROM ritual_catalog WHERE name = ?)', (new, old, new))
            conn.execute('UPDATE rituals SET name = ? WHERE name = ?', (new, old))
        except sqlite3.OperationalError:
            pass  # tabela ainda não existe


def _render_icon(src_path, dst_path):
    """Gera o ícone leve: todo branco (mantém só a transparência), 256 px, WebP."""
    from PIL import Image
    with Image.open(src_path) as im:
        im = im.convert('RGBA')
        im.thumbnail((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
        alpha = im.getchannel('A')
        out = Image.new('RGBA', im.size, (255, 255, 255, 0))
        out.putalpha(alpha)
        out.paste((255, 255, 255, 255), mask=alpha)
        tmp = dst_path + '.tmp'
        out.save(tmp, 'WEBP', quality=80, method=6)
        os.replace(tmp, dst_path)


def register(app, *, get_db, connect_db, login_required, create_ritual,
             capitalize_sentences, elements, circle_costs, element_icons,
             save_image=None, icons_src_dir=None, icons_cache_dir=None):
    # Fontes dos ícones (código) e cache gerado sob demanda (dados preservados).
    icons_src_dir = icons_src_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  'static', 'ritual_icons_src')
    icons_cache_dir = icons_cache_dir or os.path.join(app.static_folder, 'ritual_icon_cache')
    os.makedirs(icons_cache_dir, exist_ok=True)
    icon_index = _build_icon_index(icons_src_dir)

    def _icon_cache_path(slug):
        """Caminho do ícone em cache (gera na hora se ainda não existir). None se não há fonte."""
        src = icon_index.get(slug)
        if not src:
            return None
        dst = os.path.join(icons_cache_dir, slug + '.webp')
        try:
            if not os.path.isfile(dst) or os.path.getmtime(dst) < os.path.getmtime(src):
                _render_icon(src, dst)
        except Exception:
            return None
        return dst

    @app.route('/ritual-icon/<slug>.webp', endpoint='ritual_icon')
    def ritual_icon(slug):
        path = _icon_cache_path(_slug(slug))
        if not path:
            return ('', 404)
        resp = send_file(path, mimetype='image/webp', conditional=True)
        resp.headers['Cache-Control'] = 'public, max-age=2592000'
        return resp

    # ---------- tabela ----------
    conn = connect_db()
    try:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS ritual_catalog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                element TEXT NOT NULL,
                circle INTEGER NOT NULL DEFAULT 1,
                pe_cost_discente INTEGER NOT NULL DEFAULT 0,
                pe_cost_verdadeira INTEGER NOT NULL DEFAULT 0,
                execution TEXT NOT NULL DEFAULT '',
                range_ TEXT NOT NULL DEFAULT '',
                target TEXT NOT NULL DEFAULT '',
                duration TEXT NOT NULL DEFAULT '',
                resistance TEXT NOT NULL DEFAULT '',
                effect_summary TEXT NOT NULL DEFAULT '',
                description_discente TEXT NOT NULL DEFAULT '',
                description_verdadeira TEXT NOT NULL DEFAULT ''
            )
        ''')
        cols = [r[1] for r in conn.execute('PRAGMA table_info(ritual_catalog)')]
        if 'symbol' not in cols:
            conn.execute('ALTER TABLE ritual_catalog ADD COLUMN symbol TEXT')
        _fix_ritual_names(conn)
        conn.commit()
    finally:
        conn.close()

    element_by_key = {_norm(e): e for e in elements}

    # ---------- acesso ----------
    def _has_key():
        key = os.environ.get('RITUAIS_API_KEY', '')
        sent = request.headers.get('X-API-Key', '')
        return bool(key) and hmac.compare_digest(key, sent)

    def _session_user():
        uid = session.get('user_id')
        if not uid:
            return None
        return get_db().execute('SELECT id, is_admin FROM users WHERE id = ?', (uid,)).fetchone()

    def _can_read():
        return _has_key() or _session_user() is not None

    def _can_write():
        if _has_key():
            return True
        user = _session_user()
        return bool(user and user['is_admin'])

    def _deny():
        return jsonify({'ok': False, 'error': 'Sem permissão.'}), (403 if _session_user() else 401)

    # ---------- helpers ----------
    def _to_json(row):
        d = dict(row)
        d['range'] = d.pop('range_')
        d['pe_cost_normal'] = circle_costs.get(d['circle'], 0)
        slug = _slug(d.get('name'))
        d['symbol_url'] = url_for('ritual_icon', slug=slug) if slug in icon_index else ''
        return d

    def _find_element(value):
        """Elemento exato; se vier algo como "Múltiplo (Conhecimento, Energia...)",
        usa o primeiro elemento citado. Retorna (elemento, nota)."""
        key = _norm(value)
        if key in element_by_key:
            return element_by_key[key], ''
        hits = sorted((key.find(k), e) for k, e in element_by_key.items() if k in key)
        if hits:
            return hits[0][1], 'Elemento original: ' + str(value).strip() + '.'
        return None, ''

    def _clean(data, base=None):
        """Valida/normaliza um ritual. Retorna (campos, erro)."""
        merged = dict(base or {})
        merged.update({k: v for k, v in _from_pt(data or {}).items() if v is not None})

        name = capitalize_sentences(str(merged.get('name', '')).strip())
        element, element_note = _find_element(merged.get('element'))
        try:
            circle = int(merged.get('circle', 0))
        except (TypeError, ValueError):
            circle = 0
        if not name:
            return None, 'Informe o nome do ritual.'
        if element is None:
            return None, 'Elemento inválido. Use: ' + ', '.join(elements) + '.'
        if circle not in circle_costs:
            return None, 'Círculo inválido. Use: ' + ', '.join(str(c) for c in circle_costs) + '.'

        out = {'name': name[:120], 'element': element, 'circle': circle}
        for f in TEXT_FIELDS:
            out[f] = capitalize_sentences(str(merged.get(f, '') or '').strip())[:MAX_TEXT]
        if element_note:
            out['effect_summary'] = (out['effect_summary'] + ' ' + element_note).strip()

        for suffix in ('discente', 'verdadeira'):
            cost_key = 'pe_cost_' + suffix
            try:
                if merged.get('_add_' + suffix) is not None:
                    add = max(0, int(merged['_add_' + suffix]))
                    out[cost_key] = add + (circle_costs[circle] if CUSTO_PT_E_ADICIONAL else 0)
                else:
                    out[cost_key] = max(0, int(merged.get(cost_key, 0) or 0))
            except (TypeError, ValueError):
                out[cost_key] = 0
            req = merged.get('_req_' + suffix)
            desc_key = 'description_' + suffix
            if req and out[desc_key]:
                out[desc_key] = (out[desc_key] + ' Requisito: ' + str(req).strip() + '.')[:MAX_TEXT]
        return out, None

    def _duplicate(db, name, element, ignore_id=None):
        key = _norm(name)
        for r in db.execute('SELECT id, name FROM ritual_catalog WHERE element = ?', (element,)):
            if r['id'] != ignore_id and _norm(r['name']) == key:
                return True
        return False

    def _find_duplicate_id(db, name, element):
        key = _norm(name)
        for r in db.execute('SELECT id, name FROM ritual_catalog WHERE element = ?', (element,)):
            if _norm(r['name']) == key:
                return r['id']
        return None

    def _update(db, rid, f):
        db.execute(
            '''UPDATE ritual_catalog SET name=?, element=?, circle=?, pe_cost_discente=?, pe_cost_verdadeira=?,
               execution=?, range_=?, target=?, duration=?, resistance=?, effect_summary=?,
               description_discente=?, description_verdadeira=? WHERE id=?''',
            (f['name'], f['element'], f['circle'], f['pe_cost_discente'], f['pe_cost_verdadeira'],
             f['execution'], f['range'], f['target'], f['duration'], f['resistance'],
             f['effect_summary'], f['description_discente'], f['description_verdadeira'], rid))

    def _insert(db, f):
        cur = db.execute(
            '''INSERT INTO ritual_catalog
               (name, element, circle, pe_cost_discente, pe_cost_verdadeira, execution, range_,
                target, duration, resistance, effect_summary, description_discente, description_verdadeira)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (f['name'], f['element'], f['circle'], f['pe_cost_discente'], f['pe_cost_verdadeira'],
             f['execution'], f['range'], f['target'], f['duration'], f['resistance'],
             f['effect_summary'], f['description_discente'], f['description_verdadeira']))
        return cur.lastrowid

    def _payload():
        data = request.get_json(silent=True)
        return data if data is not None else request.form.to_dict()

    # ---------- página ----------
    @app.route('/rituais')
    @app.route('/admin/rituais')
    @login_required
    def rituais_panel():
        """Catálogo de rituais: todos veem; o jogador adiciona à própria ficha.
        O mestre vê também os rituais já cadastrados em cada ficha."""
        db = get_db()
        user = db.execute('SELECT * FROM users WHERE id = ?', (session['user_id'],)).fetchone()
        if not user:
            return redirect(url_for('login'))
        catalog_total = db.execute('SELECT COUNT(*) FROM ritual_catalog').fetchone()[0]
        agents, usage, my_rituals, sheets_total = {}, {}, [], 0
        if user['is_admin']:
            rows = db.execute(
                '''SELECT r.*, u.username, u.character_name
                   FROM rituals r JOIN users u ON u.id = r.user_id
                   WHERE u.is_admin = 0
                   ORDER BY LOWER(COALESCE(NULLIF(u.character_name, ''), u.username)), r.circle, LOWER(r.name)'''
            ).fetchall()
            sheets_total = len(rows)
            for r in rows:
                label = r['character_name'] or r['username']
                agents.setdefault(r['user_id'], {'label': label, 'username': r['username'], 'rituals': []})
                agents[r['user_id']]['rituals'].append(r)
                names = usage.setdefault(_norm(r['name']), [])
                if label not in names:
                    names.append(label)
            for a in db.execute('SELECT id, username, character_name FROM users WHERE is_admin = 0 ORDER BY username ASC'):
                agents.setdefault(a['id'], {'label': a['character_name'] or a['username'],
                                            'username': a['username'], 'rituals': []})
        else:
            my_rituals = [_norm(r['name']) for r in db.execute(
                'SELECT name FROM rituals WHERE user_id = ?', (user['id'],))]
        return render_template(
            'rituais_catalogo.html', user=user, agent_sheets=list(agents.values()),
            sheet_usage=usage, my_rituals=my_rituals, catalog_total=catalog_total,
            sheets_total=sheets_total, ritual_elements=elements,
            ritual_circles=list(circle_costs), ritual_element_icons=element_icons)

    # ---------- busca ----------
    @app.route('/api/rituais', methods=['GET'])
    def api_rituais_list():
        if not _can_read():
            return _deny()
        sql, params = 'SELECT * FROM ritual_catalog WHERE 1=1', []

        element = element_by_key.get(_norm(request.args.get('elemento')))
        if request.args.get('elemento') and element is None:
            return jsonify({'ok': True, 'total': 0, 'rituais': []})
        if element:
            sql += ' AND element = ?'
            params.append(element)
        circulo = request.args.get('circulo', type=int)
        if circulo:
            sql += ' AND circle = ?'
            params.append(circulo)
        sql += ' ORDER BY circle ASC, name COLLATE NOCASE ASC'

        rows = get_db().execute(sql, params).fetchall()
        q = _norm(request.args.get('q'))
        if q:
            rows = [r for r in rows if q in _norm(r['name']) or q in _norm(r['effect_summary'])]

        limit = min(max(request.args.get('limit', 50, type=int), 1), 200)
        offset = max(request.args.get('offset', 0, type=int), 0)
        return jsonify({
            'ok': True, 'total': len(rows),
            'rituais': [_to_json(r) for r in rows[offset:offset + limit]],
        })

    @app.route('/api/rituais/exportar', methods=['GET'], endpoint='rituais_export')
    def api_rituais_export():
        """Baixa o catálogo inteiro em JSON (mesmo formato aceito na importação)."""
        if not _can_write():
            return _deny()
        rows = get_db().execute(
            'SELECT * FROM ritual_catalog ORDER BY circle ASC, name COLLATE NOCASE ASC').fetchall()
        keys = ('name', 'element', 'circle', 'execution', 'range', 'target', 'duration',
                'resistance', 'effect_summary', 'pe_cost_discente', 'description_discente',
                'pe_cost_verdadeira', 'description_verdadeira')
        items = []
        for r in rows:
            d = _to_json(r)
            items.append({k: d[k] for k in keys})
        payload = {'exportado_em': datetime.now().isoformat(timespec='seconds'),
                   'total': len(items), 'rituais': items}
        resp = app.response_class(json.dumps(payload, ensure_ascii=False, indent=2),
                                  mimetype='application/json')
        resp.headers['Content-Disposition'] = (
            'attachment; filename="catalogo_rituais_%s.json"' % datetime.now().strftime('%Y-%m-%d'))
        return resp

    @app.route('/api/rituais/<int:rid>', methods=['GET'])
    def api_rituais_get(rid):
        if not _can_read():
            return _deny()
        row = get_db().execute('SELECT * FROM ritual_catalog WHERE id = ?', (rid,)).fetchone()
        if row is None:
            return jsonify({'ok': False, 'error': 'Ritual não encontrado.'}), 404
        return jsonify({'ok': True, 'ritual': _to_json(row)})

    # ---------- cadastro / edição / exclusão ----------
    @app.route('/api/rituais', methods=['POST'])
    def api_rituais_create():
        if not _can_write():
            return _deny()
        data = _payload()
        bulk = isinstance(data, list) or (isinstance(data, dict) and isinstance(data.get('rituais'), list))
        items = data if isinstance(data, list) else data.get('rituais') if bulk else [data]

        overwrite = str(request.args.get('sobrescrever', '')).lower() in ('1', 'true', 'sim')
        db = get_db()
        created, updated, errors = [], [], []
        for i, item in enumerate(items):
            fields, err = _clean(item if isinstance(item, dict) else {})
            dup_id = None
            if err is None:
                dup_id = _find_duplicate_id(db, fields['name'], fields['element'])
                if dup_id is not None and not overwrite:
                    err = f'"{fields["name"]}" ({fields["element"]}) já existe no catálogo.'
            if err:
                errors.append({'index': i, 'nome': (item.get('name') or item.get('nome')) if isinstance(item, dict) else None, 'error': err})
                continue
            if dup_id is not None:
                _update(db, dup_id, fields)
                updated.append(dup_id)
            else:
                created.append(_insert(db, fields))
        db.commit()

        if not bulk:
            if errors:
                code = 409 if 'já existe' in errors[0]['error'] else 400
                return jsonify({'ok': False, 'error': errors[0]['error']}), code
            rid = created[0] if created else updated[0]
            row = db.execute('SELECT * FROM ritual_catalog WHERE id = ?', (rid,)).fetchone()
            return jsonify({'ok': True, 'ritual': _to_json(row), 'updated': bool(updated)}), (201 if created else 200)
        ok = bool(created or updated)
        return jsonify({'ok': ok, 'created': created, 'updated': updated, 'errors': errors}), (201 if created else 200 if updated else 400)

    @app.route('/api/rituais/<int:rid>', methods=['PUT'])
    def api_rituais_update(rid):
        if not _can_write():
            return _deny()
        db = get_db()
        row = db.execute('SELECT * FROM ritual_catalog WHERE id = ?', (rid,)).fetchone()
        if row is None:
            return jsonify({'ok': False, 'error': 'Ritual não encontrado.'}), 404
        base = _to_json(row)
        fields, err = _clean(_payload(), base)
        if err:
            return jsonify({'ok': False, 'error': err}), 400
        if _duplicate(db, fields['name'], fields['element'], ignore_id=rid):
            return jsonify({'ok': False, 'error': 'Já existe outro ritual com esse nome e elemento.'}), 409
        _update(db, rid, fields)
        db.commit()
        row = db.execute('SELECT * FROM ritual_catalog WHERE id = ?', (rid,)).fetchone()
        return jsonify({'ok': True, 'ritual': _to_json(row)})

    @app.route('/api/rituais/<int:rid>', methods=['DELETE'])
    def api_rituais_delete(rid):
        if not _can_write():
            return _deny()
        db = get_db()
        cur = db.execute('DELETE FROM ritual_catalog WHERE id = ?', (rid,))
        db.commit()
        if cur.rowcount == 0:
            return jsonify({'ok': False, 'error': 'Ritual não encontrado.'}), 404
        return jsonify({'ok': True})

    # ---------- copiar para a ficha ----------
    @app.route('/api/rituais/<int:rid>/adicionar', methods=['POST'])
    def api_rituais_add_to_sheet(rid):
        me = _session_user()
        if me is None:
            return _deny()
        db = get_db()
        row = db.execute('SELECT * FROM ritual_catalog WHERE id = ?', (rid,)).fetchone()
        if row is None:
            return jsonify({'ok': False, 'error': 'Ritual não encontrado.'}), 404

        data = request.get_json(silent=True) or {}
        target_id = data.get('user_id')
        if me['is_admin']:
            if not target_id:
                return jsonify({'ok': False, 'error': 'Escolha o agente que vai receber o ritual.'}), 400
        elif target_id and int(target_id) != me['id']:
            return jsonify({'ok': False, 'error': 'Sem permissão.'}), 403
        else:
            target_id = me['id']

        try:
            target = db.execute(
                'SELECT id, is_admin FROM users WHERE id = ?', (int(target_id),)).fetchone()
        except (TypeError, ValueError):
            target = None
        if target is None or target['is_admin']:
            return jsonify({'ok': False, 'error': 'Agente não encontrado.'}), 404

        key = _norm(row['name'])
        for r in db.execute('SELECT name FROM rituals WHERE user_id = ? AND element = ?',
                            (target['id'], row['element'])):
            if _norm(r['name']) == key:
                return jsonify({'ok': False, 'error': 'Esse ritual já está na ficha.'}), 409

        f = _to_json(row)
        form = {k: f[k] for k in ('name', 'element', 'circle', 'pe_cost_discente', 'pe_cost_verdadeira',
                                   *TEXT_FIELDS)}
        # Reaproveita a criação oficial de ritual (custo de PE, log, ordenação).
        files = {}
        sym_path = _icon_cache_path(_slug(row['name']))
        if sym_path and os.path.isfile(sym_path):
            with open(sym_path, 'rb') as fh:
                files['symbol'] = FileStorage(stream=io.BytesIO(fh.read()), filename=_slug(row['name']) + '.webp')
        if not create_ritual(target['id'], form, files, require_symbol=False):
            return jsonify({'ok': False, 'error': 'Não foi possível adicionar o ritual.'}), 400
        return jsonify({'ok': True})
