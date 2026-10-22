/*
 * Sistema padrão de notificações e confirmações do site.
 *
 * Substitui os diálogos nativos do navegador (alert()/confirm() — os
 * populares "popups do Google Chrome") por um painel com a mesma
 * aparência do resto do site, igual em todas as páginas.
 *
 * Uso:
 *   showAlert('Mensagem de erro ou aviso');
 *   const ok = await askConfirm('Tem certeza?');
 *   <form onsubmit="return confirmDelete(this, 'Remover item?')">
 *   <button onclick="return confirmAndSubmit(event, 'Salvar mesmo assim?')">
 *   <form onsubmit="return confirmDeleteQty(this, 'Nome do item')">
 */
(function () {
    function injectMarkup() {
        if (document.getElementById('site-alert-overlay')) return;

        var wrap = document.createElement('div');
        wrap.innerHTML =
            '<div class="big-alert-overlay" id="site-alert-overlay">' +
                '<div class="big-alert-box">' +
                    '<button type="button" class="big-alert-close" id="site-alert-close-btn" aria-label="Fechar"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><title>x</title><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7L17 17M17 7L7 17"/></svg></button>' +
                    '<div class="big-alert-icon" id="site-alert-icon">⚠</div>' +
                    '<div class="big-alert-message" id="site-alert-message"></div>' +
                    '<div class="big-alert-total" id="site-alert-total"></div>' +
                    '<div class="big-alert-crit-badge" id="site-alert-crit-badge">🎯 CRÍTICO! 20 NATURAL!</div>' +
                '</div>' +
            '</div>' +
            '<div class="big-alert-overlay" id="site-confirm-overlay">' +
                '<div class="attack-panel-box">' +
                    '<button type="button" class="big-alert-close" id="site-confirm-cancel-btn" aria-label="Fechar"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><title>x</title><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7L17 17M17 7L7 17"/></svg></button>' +
                    '<div class="attack-panel-title" id="site-confirm-message">Tem certeza?</div>' +
                    '<button type="button" class="btn-sm btn-delete" id="site-confirm-ok-btn">Confirmar</button>' +
                '</div>' +
            '</div>';

        while (wrap.firstChild) {
            document.body.appendChild(wrap.firstChild);
        }

        document.getElementById('site-alert-close-btn').addEventListener('click', closeAlert);
        document.getElementById('site-alert-overlay').addEventListener('click', function (e) {
            if (e.target.id === 'site-alert-overlay') closeAlert();
        });

        document.getElementById('site-confirm-ok-btn').addEventListener('click', function () {
            settleConfirm(true);
        });
        document.getElementById('site-confirm-cancel-btn').addEventListener('click', function () {
            settleConfirm(false);
        });
        document.getElementById('site-confirm-overlay').addEventListener('click', function (e) {
            if (e.target.id === 'site-confirm-overlay') settleConfirm(false);
        });
    }

    var alertTimer = null;
    function closeAlert() {
        var overlay = document.getElementById('site-alert-overlay');
        if (overlay) overlay.classList.remove('is-visible');
        clearTimeout(alertTimer);
    }

    // Som de rolagem de dados, tocado sempre que um resultado de rolagem é
    // exibido em qualquer página do site (popup de rolagem, alerta de
    // perícia ou mensagem de rolagem recebida no chat).
    //
    // O áudio é carregado já na abertura da página (a 1ª rolagem não atrasa nem
    // sai cortada) e o som não é reiniciado se acabou de tocar: o arquivo dura
    // ~0,55 s, e um 2º disparo logo em seguida fazia o som "gaguejar" ou soar 2x.
    var diceAudio = null;
    var lastDiceSoundAt = 0;
    var DICE_SOUND_MIN_GAP_MS = 900;
    try {
        diceAudio = new Audio('/static/sounds/rolagemdedados.mp3');
        diceAudio.preload = 'auto';
    } catch (e) {}
    window.playDiceSound = function () {
        try {
            var now = Date.now();
            if (now - lastDiceSoundAt < DICE_SOUND_MIN_GAP_MS) return;
            lastDiceSoundAt = now;
            if (!diceAudio) {
                diceAudio = new Audio('/static/sounds/rolagemdedados.mp3');
            }
            diceAudio.currentTime = 0;
            var p = diceAudio.play();
            if (p && p.catch) p.catch(function () {});
        } catch (e) {}
    };

    // Rolagens feitas por esta própria aba (ex.: o mestre rolando a perícia de um
    // jogador): o pop-up já tocou o som, então a mensagem que volta pelo chat
    // (que chega de outro "usuário") não pode tocar uma 2ª vez.
    var ownRollIds = {};
    window.markOwnRoll = function (id) {
        if (id !== undefined && id !== null) ownRollIds[id] = true;
    };
    window.isOwnRoll = function (id) {
        return !!ownRollIds[id];
    };


    // ---- Pop-up de rolagem de dados (canto inferior direito) ----
    // Fica na tela até o usuário fechar no X: não some sozinho, não fecha
    // com Esc nem com clique fora, e continua aberto ao trocar de aba do
    // navegador. Também sobrevive à navegação entre as páginas do site (e a
    // recarregar a página), pois fica guardado em sessionStorage até ser
    // fechado. Várias rolagens se empilham, uma por pop-up.
    var ROLL_TOAST_KEY = 'rpg:rollToasts:v1';
    var ROLL_TOAST_MAX_STORED = 30;
    var rollToastSeq = 0;

    function loadRollToasts() {
        try {
            var list = JSON.parse(sessionStorage.getItem(ROLL_TOAST_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }

    function saveRollToasts(list) {
        try {
            sessionStorage.setItem(ROLL_TOAST_KEY, JSON.stringify(list.slice(-ROLL_TOAST_MAX_STORED)));
        } catch (e) {}
    }

    function getRollToastStack() {
        var stack = document.getElementById('roll-toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'roll-toast-stack';
            stack.className = 'roll-toast-stack';
            stack.setAttribute('role', 'region');
            stack.setAttribute('aria-label', 'Resultados de rolagens');
            stack.setAttribute('aria-live', 'polite');
            (document.body || document.documentElement).appendChild(stack);
        }
        return stack;
    }

    function dismissRollToast(id, el) {
        saveRollToasts(loadRollToasts().filter(function (t) { return t.id !== id; }));
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }


    // ---- Personalização do pop-up de rolagem ----
    // O jogador escolhe a skin do dado; a cor da borda, do ícone e do número do
    // pop-up é sempre a cor dominante da skin escolhida (campo `cor` de RT_DICE;
    // sem skin, vale a cor padrão do tema). O botão "Personalizar" fica no
    // cabeçalho, à esquerda de "Sair", e abre um pop-up próprio com as skins. A
    // escolha vale para todos os pop-ups de rolagem deste navegador e fica
    // guardada em localStorage.
    var RT_STYLE_KEY = 'rpg:rollToastStyle:v1';
    // "Skins": imagens de dado que substituem o d20 do pop-up de rolagem ('' = d20 padrão).
    // `cor` = cor dominante da imagem (usada na borda/ícone/número do pop-up).
    var RT_DICE = [
        { id: 'sangue',       nome: 'Sangue',       src: '/static/dice/dado_sangue.png',       cor: '#E31B1B' },
        { id: 'energia',      nome: 'Energia',      src: '/static/dice/dado_energia.png',      cor: '#9A3DF0' },
        { id: 'morte',        nome: 'Morte',        src: '/static/dice/dado_morte.png',        cor: '#D0D0D0' },
        { id: 'conhecimento', nome: 'Conhecimento', src: '/static/dice/dado_conhecimento.png', cor: '#E6D400' },
        { id: 'biohazard',    nome: 'Biohazard',    src: '/static/dice/dado_biohazard.png',    cor: '#F0A800' }
    ];
    var RT_DEFAULTS = { dice: '' };
    function rtDiceById(id) {
        for (var i = 0; i < RT_DICE.length; i++) if (RT_DICE[i].id === id) return RT_DICE[i];
        return null;
    }
    var rtStyle = loadRollToastStyle();

    function loadRollToastStyle() {
        var out = {};
        for (var k in RT_DEFAULTS) out[k] = RT_DEFAULTS[k];
        try {
            var saved = JSON.parse(localStorage.getItem(RT_STYLE_KEY) || '{}');
            if (saved && typeof saved === 'object') {
                for (var key in RT_DEFAULTS) {
                    if (key === 'dice' && typeof saved.dice === 'string' && rtDiceById(saved.dice)) {
                        out.dice = saved.dice;
                    }
                }
            }
        } catch (e) {}
        return out;
    }

    function saveRollToastStyle() {
        try { localStorage.setItem(RT_STYLE_KEY, JSON.stringify(rtStyle)); } catch (e) {}
    }

    // Converte qualquer cor/variável CSS em #rrggbb (para preencher os seletores de cor).
    function resolveCssColorToHex(cssValue) {
        var probe = document.createElement('span');
        probe.style.color = cssValue;
        probe.style.display = 'none';
        document.body.appendChild(probe);
        var rgb = getComputedStyle(probe).color;
        document.body.removeChild(probe);
        var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
        if (!m) return '#000000';
        return '#' + [m[1], m[2], m[3]].map(function (v) {
            return ('0' + parseInt(v, 10).toString(16)).slice(-2);
        }).join('');
    }

    function applyRollToastStyle() {
        var root = document.documentElement;
        function setVar(name, value) {
            if (value === '' || value === null || value === undefined) root.style.removeProperty(name);
            else root.style.setProperty(name, value);
        }
        var d = rtDiceById(rtStyle.dice);
        setVar('--rt-accent', d ? d.cor : '');
    }
    applyRollToastStyle();

    var ROLL_ICON_SVG = '<svg viewBox="-16 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M106.75 215.06L1.2 370.95c-3.08 5 .1 11.5 5.93 12.14l208.26 22.07-108.64-190.1zM7.41 315.43L82.7 193.08 6.06 147.1c-2.67-1.6-6.06.32-6.06 3.43v162.81c0 4.03 5.29 5.53 7.41 2.09zM18.25 423.6l194.4 87.66c5.3 2.45 11.35-1.43 11.35-7.26v-65.67l-203.55-22.3c-4.45-.5-6.23 5.59-2.2 7.57zm81.22-257.78L179.4 22.88c4.34-7.06-3.59-15.25-10.78-11.14L17.81 110.35c-2.47 1.62-2.39 5.26.13 6.78l81.53 48.69zM240 176h109.21L253.63 7.62C250.5 2.54 245.25 0 240 0s-10.5 2.54-13.63 7.62L130.79 176H240zm233.94-28.9l-76.64 45.99 75.29 122.35c2.11 3.44 7.41 1.94 7.41-2.1V150.53c0-3.11-3.39-5.03-6.06-3.43zm-93.41 18.72l81.53-48.7c2.53-1.52 2.6-5.16.13-6.78l-150.81-98.6c-7.19-4.11-15.12 4.08-10.78 11.14l79.93 142.94zm79.02 250.21L256 438.32v65.67c0 5.84 6.05 9.71 11.35 7.26l194.4-87.66c4.03-1.97 2.25-8.06-2.2-7.56zm-86.3-200.97l-108.63 190.1 208.26-22.07c5.83-.65 9.01-7.14 5.93-12.14L373.25 215.06zM240 208H139.57L240 383.75 340.43 208H240z"/></svg>';

    // Ícone do pop-up: o dado elemental escolhido (imagem) ou o d20 padrão (SVG).
    function rollIconHtml() {
        var d = rtDiceById(rtStyle.dice);
        if (!d) return ROLL_ICON_SVG;
        return '<img class="roll-toast-dice-img" src="' + d.src + '" alt="Dado de ' + d.nome + '" draggable="false">';
    }

    // Pop-up com as skins de dado (aberto pelo botão do cabeçalho).
    var rtModal = null;

    function buildRollToastModal() {
        var overlay = document.createElement('div');
        overlay.className = 'big-alert-overlay rt-style-overlay';
        overlay.id = 'rt-style-overlay';

        var box = document.createElement('div');
        box.className = 'attack-panel-box rt-modal-box';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', 'Personalizar pop-up de rolagem');

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'big-alert-close';
        close.setAttribute('aria-label', 'Fechar');
        close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7L17 17M17 7L7 17"/></svg>';
        box.appendChild(close);

        var title = document.createElement('div');
        title.className = 'attack-panel-title';
        title.textContent = 'Personalizar pop-up de rolagem';
        box.appendChild(title);

        // Prévia: usa as mesmas variáveis dos pop-ups reais, então já reflete a skin escolhida.
        var preview = document.createElement('div');
        preview.className = 'roll-toast no-anim';
        preview.innerHTML =
            '<div class="roll-toast-icon">' + rollIconHtml() + '</div>' +
            '<div class="roll-toast-label">Exemplo</div>' +
            '<div class="roll-toast-total">17</div>' +
            '<div class="roll-toast-detail">1d20 + 3</div>';
        box.appendChild(preview);
        var previewIcon = preview.querySelector('.roll-toast-icon');

        // ---- Skins ----
        var diceTitle = document.createElement('div');
        diceTitle.className = 'rt-section-title';
        diceTitle.textContent = 'Skins';
        box.appendChild(diceTitle);

        var diceGrid = document.createElement('div');
        diceGrid.className = 'rt-dice-grid';
        diceGrid.setAttribute('role', 'radiogroup');
        diceGrid.setAttribute('aria-label', 'Skins de dado');
        var diceBtns = [];
        [{ id: '', nome: 'Padrão', src: '' }].concat(RT_DICE).forEach(function (d) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'rt-dice-opt';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-label', 'Dado ' + d.nome);
            b.title = d.nome;
            b.innerHTML = (d.src
                ? '<img src="' + d.src + '" alt="" draggable="false">'
                : '<span class="rt-dice-opt-default">' + ROLL_ICON_SVG + '</span>') +
                '<span class="rt-dice-opt-name">' + d.nome + '</span>';
            b.addEventListener('click', function () {
                rtStyle.dice = d.id;
                applyRollToastStyle();
                saveRollToastStyle();
                refresh();
            });
            diceGrid.appendChild(b);
            diceBtns.push({ el: b, id: d.id });
        });
        box.appendChild(diceGrid);

        var actions = document.createElement('div');
        actions.className = 'roll-toast-panel-actions';
        var reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = 'Restaurar padrão';
        var done = document.createElement('button');
        done.type = 'button';
        done.textContent = 'Concluir';
        actions.appendChild(reset);
        actions.appendChild(done);
        box.appendChild(actions);
        overlay.appendChild(box);

        function refresh() {
            previewIcon.innerHTML = rollIconHtml();
            diceBtns.forEach(function (db) {
                var on = rtStyle.dice === db.id;
                db.el.classList.toggle('is-selected', on);
                db.el.setAttribute('aria-checked', on ? 'true' : 'false');
            });
        }
        function closeModal() { overlay.classList.remove('is-visible'); }

        reset.addEventListener('click', function () {
            for (var k in RT_DEFAULTS) rtStyle[k] = RT_DEFAULTS[k];
            applyRollToastStyle();
            saveRollToastStyle();
            refresh();
        });
        done.addEventListener('click', closeModal);
        close.addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && overlay.classList.contains('is-visible')) closeModal();
        });

        document.body.appendChild(overlay);
        return { overlay: overlay, refresh: refresh };
    }

    function openRollToastModal() {
        if (!rtModal) rtModal = buildRollToastModal();
        rtModal.refresh();
        rtModal.overlay.classList.add('is-visible');
    }

    // Botão "Personalizar": uma aba no cabeçalho, logo à esquerda de "Sair" (que fica por último, à direita).
    function injectCustomizeLink() {
        if (document.getElementById('rt-open-link')) return;
        var logout = document.querySelector('header a[href*="logout"]');
        if (!logout || !logout.parentNode) return;

        var link = document.createElement('a');
        link.href = '#';
        link.id = 'rt-open-link';
        link.setAttribute('role', 'button');
        link.setAttribute('title', 'Personalizar o pop-up de rolagem (skins de dado)');
        link.textContent = 'Personalizar';
        link.addEventListener('click', function (e) {
            e.preventDefault();
            openRollToastModal();
        });

        var parent = logout.parentNode;
        if (parent.tagName === 'HEADER') {
            // Cabeçalho do jogador: "Sair" é filho direto; agrupa os dois para manter o layout.
            var group = document.createElement('div');
            group.className = 'header-actions';
            parent.insertBefore(group, logout);
            // "Importar ficha" (botão discreto do jogador) entra no mesmo grupo para ficar alinhado.
            var importBtn = document.getElementById('import-sheet-open');
            if (importBtn) group.appendChild(importBtn);
            group.appendChild(link);
            group.appendChild(logout);
        } else {
            parent.insertBefore(link, logout);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectCustomizeLink);
    } else {
        injectCustomizeLink();
    }

    function renderRollToast(t, animate) {
        var el = document.createElement('div');
        el.className = 'roll-toast' + (t.critical ? ' is-critical' : '') + (animate ? '' : ' no-anim');
        el.setAttribute('role', 'status');
        el.dataset.toastId = t.id;

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'roll-toast-close';
        close.setAttribute('aria-label', 'Fechar');
        close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7L17 17M17 7L7 17"/></svg>';
        close.addEventListener('click', function () { dismissRollToast(t.id, el); });
        el.appendChild(close);

        var icon = document.createElement('div');
        icon.className = 'roll-toast-icon';
        icon.innerHTML = rollIconHtml();
        el.appendChild(icon);

        var label = document.createElement('div');
        label.className = 'roll-toast-label';
        label.textContent = t.label || '';
        el.appendChild(label);

        if (t.total !== undefined && t.total !== null && t.total !== '') {
            var total = document.createElement('div');
            total.className = 'roll-toast-total';
            total.textContent = t.total;
            el.appendChild(total);
        }
        if (t.detail) {
            var detail = document.createElement('div');
            detail.className = 'roll-toast-detail';
            detail.textContent = t.detail;
            el.appendChild(detail);
        }
        if (t.critical) {
            var badge = document.createElement('div');
            badge.className = 'roll-toast-crit';
            badge.textContent = '🎯 CRÍTICO!';
            el.appendChild(badge);
        }
        getRollToastStack().appendChild(el);
        return el;
    }

    window.showRollToast = function (label, detail, total, isCritical) {
        var t = {
            id: Date.now().toString(36) + '-' + (++rollToastSeq),
            label: label,
            detail: detail || '',
            total: total,
            critical: !!isCritical
        };
        var list = loadRollToasts();
        list.push(t);
        saveRollToasts(list);
        renderRollToast(t, true);
        playDiceSound();
        return false;
    };

    // Reexibe, sem tocar som, os pop-ups que ainda não foram fechados
    // (ao trocar de página do site ou recarregar).
    function restoreRollToasts() {
        var list = loadRollToasts();
        if (!list.length) return;
        list.forEach(function (t) { renderRollToast(t, false); });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', restoreRollToasts);
    } else {
        restoreRollToasts();
    }

    // Substitui alert('mensagem').
    // opts.icon permite trocar o ícone padrão (⚠) por outro símbolo pontual.
    // opts.total, quando definido, exibe o número em destaque (grande e
    // colorido) abaixo da mensagem — usado para deixar o resultado final
    // de uma rolagem mais explícito em vez de ficar perdido no meio do texto.
    // opts.critical, quando true, destaca o pop-up (borda/selo) para
    // indicar que a rolagem tirou um 20 natural.
    window.showAlert = function (message, opts) {
        opts = opts || {};
        if (opts.icon === '🎲') {
            // Resultado de rolagem: vai para o pop-up fixo do canto inferior direito.
            var rollMsg = String(message);
            if (opts.total !== undefined && opts.total !== null) {
                rollMsg = rollMsg.replace(/\s*=\s*[^=]*$/, '').trim();
            }
            return window.showRollToast(rollMsg, '', opts.total, !!opts.critical);
        }
        injectMarkup();
        var totalEl = document.getElementById('site-alert-total');
        if (opts.total !== undefined && opts.total !== null) {
            // Remove o "= <total>" final da mensagem para não repetir o
            // número — ele passa a aparecer só uma vez, em destaque.
            message = String(message).replace(/\s*=\s*[^=]*$/, '').trim();
            totalEl.textContent = '= ' + opts.total;
            totalEl.style.display = 'block';
        } else {
            totalEl.textContent = '';
            totalEl.style.display = 'none';
        }
        document.getElementById('site-alert-message').textContent = message;
        document.getElementById('site-alert-icon').textContent = opts.icon || '⚠';
        if (opts.icon === '🎲') {
            playDiceSound();
        }
        var box = document.querySelector('#site-alert-overlay .big-alert-box');
        var critBadge = document.getElementById('site-alert-crit-badge');
        var isCritical = !!opts.critical;
        if (box) box.classList.toggle('is-critical', isCritical);
        if (critBadge) critBadge.style.display = isCritical ? 'block' : 'none';
        document.getElementById('site-alert-overlay').classList.add('is-visible');
        clearTimeout(alertTimer);
        if (opts.autoClose !== false) {
            alertTimer = setTimeout(closeAlert, opts.duration || 4000);
        }
        return false;
    };

    // Mantido por compatibilidade com nome anterior específico de dinheiro.
    window.showMoneyAlert = function (message) {
        return window.showAlert(message, { duration: 3500 });
    };

    var confirmResolve = null;
    function settleConfirm(result) {
        var overlay = document.getElementById('site-confirm-overlay');
        if (overlay) overlay.classList.remove('is-visible');
        var resolve = confirmResolve;
        confirmResolve = null;
        if (resolve) resolve(result);
    }

    // Substitui confirm('mensagem'); retorna uma Promise<boolean>.
    window.askConfirm = function (message) {
        injectMarkup();
        document.getElementById('site-confirm-message').textContent = message;
        document.getElementById('site-confirm-overlay').classList.add('is-visible');
        return new Promise(function (resolve) {
            confirmResolve = resolve;
        });
    };

    // Uso em <form onsubmit="return confirmDelete(this, 'Mensagem?')">.
    // Bloqueia o envio nativo, pergunta e envia o formulário se confirmado.
    window.confirmDelete = function (form, message) {
        window.askConfirm(message).then(function (ok) {
            if (ok) form.submit();
        });
        return false;
    };

    // Uso em <button type="submit" onclick="return confirmAndSubmit(event, 'Mensagem?')">.
    window.confirmAndSubmit = function (event, message) {
        var btn = event.currentTarget || event.target;
        var form = btn.closest('form');
        window.askConfirm(message).then(function (ok) {
            if (ok && form) form.submit();
        });
        return false;
    };

    // Uso em formulários de exclusão de item que têm um <input name="quantity">
    // para o usuário escolher quantas unidades remover.
    window.confirmDeleteQty = function (form, itemName) {
        var qtyInput = form.querySelector('input[name="quantity"]');
        var max = qtyInput ? parseInt(qtyInput.max, 10) : 1;
        if (!max || max < 1) max = 1;
        var qty = qtyInput ? parseInt(qtyInput.value, 10) : 1;
        if (!qty || qty < 1) qty = 1;
        if (qty > max) qty = max;
        if (qtyInput) qtyInput.value = qty;

        var message = qty >= max
            ? ('Remover o item ' + itemName + (max > 1 ? (' (todas as ' + max + ' unidades)') : '') + '?')
            : ('Remover ' + qty + ' unidade' + (qty > 1 ? 's' : '') + ' de ' + itemName + '? (restam ' + (max - qty) + ')');

        return window.confirmDelete(form, message);
    };

    // Troca uma <img> que falhou ao carregar (o registro existe no banco,
    // mas o arquivo não foi encontrado no servidor) por um aviso de erro
    // explícito, em vez do ícone de imagem quebrada do navegador
    // sobrepondo o texto ao lado.
    // Uso: <img onerror="return imgFallback(this, 'item')">
    var IMG_FALLBACKS = {
        item: '<div class="item-img-placeholder img-load-error">404<br>imagem não carregada</div>',
        avatar: '<div class="avatar-placeholder img-load-error">404<br>imagem não carregada</div>',
        'avatar-sm': '<div class="avatar-placeholder avatar-placeholder-sm img-load-error" title="Erro 404: imagem não carregada">404</div>',
        'agent-avatar': '<div class="agent-avatar-placeholder img-load-error" title="Erro 404: imagem não carregada">404</div>',
        banner: '<div class="campaign-banner-placeholder img-load-error">404 - imagem não carregada</div>'
    };

    window.imgFallback = function (img, kind) {
        if (!img || img.dataset.fallbackApplied) return false;
        img.dataset.fallbackApplied = '1';
        var placeholderHtml = IMG_FALLBACKS[kind];
        if (!placeholderHtml) {
            img.style.display = 'none';
            return false;
        }
        var wrap = document.createElement('div');
        wrap.innerHTML = placeholderHtml;
        var placeholder = wrap.firstElementChild;
        if (placeholder && img.parentNode) {
            img.replaceWith(placeholder);
        } else {
            img.style.display = 'none';
        }
        return false;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectMarkup);
    } else {
        injectMarkup();
    }

    // Indicador de mensagens não lidas na aba "Chat" da navegação,
    // visível em qualquer outra página do site. A própria página do
    // chat marca tudo como lido no servidor (ao carregar e a cada
    // poll), então aqui só precisamos consultar a contagem periodicamente.
    var UNREAD_POLL_MS = 8000;

    function pollChatUnread() {
        var link = document.getElementById('combat-chat-toggle');
        if (!link) return; // página sem o chat (ex: login)

        fetch('/chat/api/unread')
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (!data) return;
                // Chat aberto: o próprio chat já marca tudo como lido.
                var open = link.getAttribute('aria-expanded') === 'true';
                link.classList.toggle('has-unread', !!data.unread && !open);
                if (typeof data.sem_sanidade !== 'undefined' && document.body) {
                    document.body.classList.toggle('sem-sanidade', !!data.sem_sanidade);
                }
            })
            .catch(function () {
                // Falha silenciosa (ex: sessão expirada) — não interrompe a página.
            });
    }

    function initChatUnreadPolling() {
        if (!document.getElementById('combat-chat-toggle')) return;
        pollChatUnread();
        setInterval(pollChatUnread, UNREAD_POLL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChatUnreadPolling);
    } else {
        initChatUnreadPolling();
    }

    // ---- Encolhe a folga de baixo do card quando o "Adicionar
    // Habilidade/Ritual/Item" está fechado (sem o formulário aberto),
    // pra ficar do mesmo tamanho da folga de cima do resumo. Feito via
    // classe + JS (em vez de só CSS com :has()) pra funcionar em
    // qualquer navegador, mesmo os que não suportam :has(). ----
    function syncFormDetailsSpacing(details) {
        var card = details.closest('.panel-section, .category-block, .user-card');
        if (!card) return;
        card.classList.toggle('form-collapsed', !details.open);
    }

    // ---- Seta (▸/▾) do "Adicionar Habilidade/Ritual/Item", controlada
    // por JS em vez de CSS ::before + [open]: assim ela nunca fica presa
    // apontando pra baixo, porque é atualizada no mesmo evento "toggle"
    // que já disparava o ajuste de espaçamento acima. ----
    function syncFormDetailsArrow(details) {
        var summary = details.querySelector('summary');
        if (!summary) return;
        var arrow = summary.querySelector('.add-form-details-arrow');
        if (!arrow) {
            arrow = document.createElement('span');
            arrow.className = 'add-form-details-arrow';
            summary.insertBefore(arrow, summary.firstChild);
        }
        arrow.textContent = details.open ? '\u25BE ' : '\u25B8 ';
    }

    function initFormDetailsSpacing() {
        document.querySelectorAll('.add-form-details').forEach(function (details) {
            syncFormDetailsSpacing(details);
            syncFormDetailsArrow(details);
            details.addEventListener('toggle', function () {
                syncFormDetailsSpacing(details);
                syncFormDetailsArrow(details);
            });
        });
        // "Ver / editar detalhes completos": mesma lógica de folga acima,
        // mas sem a seta via JS — esse "details" já tem sua própria seta
        // (▸/▾) desenhada em CSS puro (::before), então só sincronizamos
        // o espaçamento do card por baixo.
        document.querySelectorAll('.user-details').forEach(function (details) {
            syncFormDetailsSpacing(details);
            details.addEventListener('toggle', function () {
                syncFormDetailsSpacing(details);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initFormDetailsSpacing);
    } else {
        initFormDetailsSpacing();
    }

    // ---- Ajuda os polls periódicos (ficha do jogador, agentes, campanha)
    // a pausar enquanto a pessoa está digitando em algum campo de texto,
    // evitando que uma atualização vinda do servidor sobrescreva o que
    // ela está escrevendo no meio da digitação. ----
    var TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
    window.isTypingInField = function () {
        var el = document.activeElement;
        if (!el) return false;
        if (el.isContentEditable) return true;
        var tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag === 'INPUT') {
            var type = (el.type || 'text').toLowerCase();
            return TEXT_INPUT_TYPES.indexOf(type) !== -1;
        }
        return false;
    };
})();

/*
 * Auto-capitalização dos campos de texto ao cadastrar um ritual: deixa
 * maiúscula a primeira letra do campo e a primeira letra de cada frase
 * seguinte (após ., ! ou ?), conforme o jogador/mestre digita.
 */
(function () {
    function capitalizeSentences(text) {
        if (!text) return text;
        text = text.charAt(0).toUpperCase() + text.slice(1);
        return text.replace(/([.!?]\s+)([a-zà-ú])/g, function (match, sep, letter) {
            return sep + letter.toUpperCase();
        });
    }

    function attachAutoCapitalize(el) {
        el.addEventListener('input', function () {
            var start = el.selectionStart;
            var end = el.selectionEnd;
            var newValue = capitalizeSentences(el.value);
            if (newValue !== el.value) {
                el.value = newValue;
                if (start !== null) el.setSelectionRange(start, end);
            }
        });
    }

    function initRitualAutoCapitalize() {
        document.querySelectorAll('.add-ritual-form input[type="text"], .add-ritual-form textarea')
            .forEach(attachAutoCapitalize);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initRitualAutoCapitalize);
    } else {
        initRitualAutoCapitalize();
    }
})();

/*
 * Polling econômico: aba em segundo plano consulta o servidor 5x menos
 * e, ao voltar para a aba, atualiza na hora.
 */
window.pollWhenVisible = function (fn, ms) {
    var hiddenTicks = 0;
    setInterval(function () {
        if (document.hidden) {
            hiddenTicks++;
            if (hiddenTicks % 5 !== 0) return;
        } else {
            hiddenTicks = 0;
        }
        fn();
    }, ms);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) fn();
    });
};

/* Nome do PE: no modo "Jogar sem Sanidade" ele aparece como PD.
   PE_T contém as duas versões; o CSS mostra só a que vale no momento
   (por isso a troca acontece ao vivo, sem recarregar). */
window.PE_T = '<span class="t-pe">PE</span><span class="t-pd">PD</span>';
window.peLabel = function () {
    return document.body && document.body.classList.contains('sem-sanidade') ? 'PD' : 'PE';
};


/* Clicar na foto de um item (inventário) amplia a imagem; clicar de novo
   ou apertar Esc fecha. As miniaturas pequenas do painel de combate não
   abrem, para não atrapalhar os cliques da lista. */
(function () {
    function closeLightbox() {
        var box = document.getElementById('item-lightbox');
        if (box) box.remove();
    }

    document.addEventListener('click', function (e) {
        var img = e.target.closest ? e.target.closest('img.item-img') : null;
        if (!img || img.classList.contains('combat-inv-thumb')) return;

        closeLightbox();
        var box = document.createElement('div');
        box.id = 'item-lightbox';
        box.className = 'item-lightbox';

        var big = document.createElement('img');
        big.src = img.src;
        big.alt = img.alt || '';
        box.appendChild(big);

        if (img.alt) {
            var cap = document.createElement('div');
            cap.className = 'item-lightbox-caption';
            cap.textContent = img.alt;
            box.appendChild(cap);
        }

        box.addEventListener('click', closeLightbox);
        document.body.appendChild(box);
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeLightbox();
    });
})();

/*
 * Tempo real (WebSocket): o chat fixo (_chat_dock.html) mantém a conexão e
 * repassa para cá os eventos do servidor. Cada página se inscreve no que
 * lhe interessa, ex.: rpgRealtime.on('images', function (ev) { ... }).
 * Se o WebSocket não estiver disponível, nada é emitido e as páginas
 * continuam se atualizando pelo polling de sempre.
 */
window.rpgRealtime = (function () {
    var handlers = {};
    return {
        connected: false,  // true enquanto o WebSocket do chat estiver aberto
        on: function (type, fn) {
            (handlers[type] = handlers[type] || []).push(fn);
        },
        emit: function (type, data) {
            (handlers[type] || []).forEach(function (fn) {
                try { fn(data); } catch (e) { console.error('rpgRealtime', type, e); }
            });
        }
    };
})();
