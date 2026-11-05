/**
 * Replacement for Blockly.prompt. scratch-blocks calls window.prompt for "Make a Variable",
 * "Make a List", new broadcast messages and custom block names, and Electron does not
 * support window.prompt. This shows a small in-page dialog instead.
 *
 * Contract (from scratch-blocks): prompt(message, defaultValue, callback, optTitle, optVarType)
 * and callback(text, additionalVars, options) where options = { scope: 'local' | 'global', isCloud }.
 * Cancelling calls callback(null).
 */
export function showPrompt(
    message: string,
    defaultValue: string,
    callback: (text: string | null, additionalVars?: unknown, options?: { scope: string; isCloud: boolean }) => void,
    optTitle?: string,
    optVarType?: string,
): void {
    // Variables ('') and lists ('list') get a scope choice; messages and procedures do not.
    const hasScope = optVarType === '' || optVarType === 'list';

    const overlay = document.createElement('div');
    overlay.className = 'cw-modal-overlay';

    const dialog = document.createElement('form');
    dialog.className = 'cw-modal';

    const title = document.createElement('h2');
    title.textContent = optTitle || message;
    dialog.appendChild(title);

    if (optTitle) {
        const label = document.createElement('p');
        label.textContent = message;
        dialog.appendChild(label);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue ?? '';
    dialog.appendChild(input);

    let scopeAll: HTMLInputElement | null = null;
    if (hasScope) {
        const group = document.createElement('div');
        group.className = 'cw-modal-scope';
        const mk = (value: string, text: string, checked: boolean): HTMLInputElement => {
            const label = document.createElement('label');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'cw-scope';
            radio.value = value;
            radio.checked = checked;
            label.append(radio, ` ${text}`);
            group.appendChild(label);
            return radio;
        };
        scopeAll = mk('global', 'For all sprites', true);
        mk('local', 'For this sprite only', false);
        dialog.appendChild(group);
    }

    const buttons = document.createElement('div');
    buttons.className = 'cw-modal-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.textContent = 'OK';
    ok.className = 'active';
    buttons.append(cancel, ok);
    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input.focus();
    input.select();

    const close = (result: string | null) => {
        overlay.remove();
        if (result === null) {
            callback(null);
        } else {
            callback(result, null, { scope: scopeAll && !scopeAll.checked ? 'local' : 'global', isCloud: false });
        }
    };

    dialog.addEventListener('submit', (e) => {
        e.preventDefault();
        close(input.value);
    });
    cancel.addEventListener('click', () => close(null));
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(null);
    });
}