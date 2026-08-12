window.SFSymbols = (function() {
    var st = document.createElement('style');
    st.textContent = '.sf-icon{pointer-events:none;-webkit-user-drag:none}';
    document.head.appendChild(st);

    var currentColor = null;
    var COLOR_VARS = ['--icon-color', '--text-primary', '--text', '--fg', '--ink', '--title'];

    // Resolve the icon tint from the widget's own text-color variable, read from the
    // requesting element's own computed style (not document.body) — some widgets put
    // their theme class on #widget/<html> rather than <body>, and a custom property only
    // cascades to descendants of whichever element defines it, not up to an ancestor.
    // Widgets name the variable differently, so try the common names (plus an explicit
    // --icon-color override) before falling back to white.
    function resolveColor(el) {
        var s = getComputedStyle(el || document.body);
        for (var i = 0; i < COLOR_VARS.length; i++) {
            var c = s.getPropertyValue(COLOR_VARS[i]).trim();
            if (c) return c;
        }
        return '#ffffff';
    }

    function iconColor(el) {
        return resolveColor(el || document.querySelector('img.sf-icon[data-symbol]'));
    }

    async function loadOne(img) {
        var name = img.dataset.symbol;
        if (!name) return;
        var size = parseInt(img.dataset.size, 10) || 18;
        var weight = img.dataset.weight || 'regular';
        try {
            var url = await window.NepTunes.symbol(name, {
                size: size,
                weight: weight,
                color: resolveColor(img)
            });
            if (url) img.src = url;
        } catch (e) {
            console.warn('SFSymbols: failed to load', name, e);
        }
    }

    async function loadAll() {
        var icons = document.querySelectorAll('img.sf-icon[data-symbol]');
        await Promise.all(Array.prototype.map.call(icons, loadOne));
    }

    async function load() {
        var color = iconColor();
        if (color === currentColor) return;
        currentColor = color;
        await loadAll();
    }

    async function reload() {
        currentColor = null;
        await load();
    }

    async function setSrc(imgEl, symbolName, opts) {
        opts = opts || {};
        var size = opts.size || parseInt(imgEl.dataset.size, 10) || 18;
        var color = opts.color || resolveColor(imgEl);
        try {
            var url = await window.NepTunes.symbol(symbolName, { size: size, color: color });
            if (url) imgEl.src = url;
        } catch (e) {
            console.warn('SFSymbols: failed to set', symbolName, e);
        }
    }

    // Icons are PNGs the native side rasterises with the tint baked in, so unlike CSS-driven
    // colours they cannot follow a system light/dark switch on their own -- they have to be
    // re-fetched. Do it here, once, rather than in each widget: every bundle ships this file
    // verbatim, and leaving it to the widgets is what left every icon stale on a flip.
    //
    // Deferred to a macrotask so the widget's own `themechange` handler (which toggles the
    // theme class) has landed first -- resolveColor reads computed style synchronously, so
    // running before the class flip would re-bake the OLD colour.
    //
    // `reload`, NOT `load`: load() skips everything when iconColor() looks unchanged, and
    // iconColor() samples whichever icon happens to be first in the DOM. That icon is often
    // inside a hidden placeholder (e.g. FullPlayer's #noArtwork), and WebKit does not
    // recompute inherited custom properties inside a display:none subtree -- so the sample
    // still reads the pre-flip colour and every icon silently stays stale. reload() bypasses
    // that check and re-resolves each icon against its OWN computed style. Widgets pinned to
    // an explicit colour simply re-fetch the same tint, which is a no-op the user cannot see.
    if (window.NepTunes && typeof window.NepTunes.on === 'function') {
        window.NepTunes.on('themechange', function() { setTimeout(reload, 0); });
    }

    return { load: load, reload: reload, setSrc: setSrc, getColor: iconColor };
})();
