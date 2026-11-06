/**
 * "Make a Block" / "Edit" dialog for custom blocks (procedures).
 *
 * scratch-blocks has no built-in editor for this: it calls
 * Blockly.Procedures.externalProcedureDefCallback(mutation, callback) and expects the host app
 * to show UI. scratch-gui does that with a big modal; this is a simpler list-based version.
 *
 * A custom block is a list of parts: text labels, inputs (number/text, "%s") and boolean
 * inputs ("%b"). The result is a <mutation> element with the attributes scratch-vm reads:
 * proccode, argumentids, argumentnames, argumentdefaults, warp.
 */

type PartKind = 'label' | 'input' | 'bool';

interface Part {
    kind: PartKind;
    text: string; // label text, or the argument's name
    id: string; // argument id (unused for labels)
    def: string | boolean; // argument default (unused for labels)
}

const newId = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `arg_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

function parseJsonArray(text: string | null | undefined): unknown[] {
    if (!text) return [];
    try {
        const value = JSON.parse(text);
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

/** Turn an existing mutation (when editing a block) into a list of parts. */
function partsFromMutation(mutation: Element | null): Part[] {
    const proccode = mutation?.getAttribute('proccode') ?? '';
    if (!proccode) {
        return [{ kind: 'label', text: 'my block', id: '', def: '' }];
    }
    const ids = parseJsonArray(mutation?.getAttribute('argumentids'));
    const names = parseJsonArray(mutation?.getAttribute('argumentnames'));
    const defaults = parseJsonArray(mutation?.getAttribute('argumentdefaults'));

    const parts: Part[] = [];
    let label: string[] = [];
    let argIndex = 0;
    const flushLabel = () => {
        if (label.length > 0) parts.push({ kind: 'label', text: label.join(' '), id: '', def: '' });
        label = [];
    };

    for (const token of proccode.split(' ')) {
        if (token === '%s' || token === '%b') {
            flushLabel();
            parts.push({
                kind: token === '%b' ? 'bool' : 'input',
                text: String(names[argIndex] ?? `arg${argIndex + 1}`),
                id: String(ids[argIndex] ?? newId()),
                def: (defaults[argIndex] as string | boolean | undefined) ?? (token === '%b' ? false : ''),
            });
            argIndex++;
        } else {
            label.push(token);
        }
    }
    flushLabel();
    return parts;
}

/** Turn the edited parts into a <mutation> element. Returns null if the block is invalid. */
function mutationFromParts(parts: Part[], warp: boolean): Element | null {
    const codeParts: string[] = [];
    const ids: string[] = [];
    const names: string[] = [];
    const defaults: (string | boolean)[] = [];
    let hasLabel = false;

    for (const part of parts) {
        if (part.kind === 'label') {
            const text = part.text.replace(/%/g, '').trim();
            if (!text) continue;
            hasLabel = true;
            codeParts.push(text);
        } else {
            const name = part.text.trim() || `arg${ids.length + 1}`;
            codeParts.push(part.kind === 'bool' ? '%b' : '%s');
            ids.push(part.id || newId());
            names.push(name);
            defaults.push(part.kind === 'bool' ? false : part.def === false ? '' : part.def);
        }
    }
    if (!hasLabel) return null;

    const mutation = document.createElement('mutation');
    mutation.setAttribute('proccode', codeParts.join(' '));
    mutation.setAttribute('argumentids', JSON.stringify(ids));
    mutation.setAttribute('argumentnames', JSON.stringify(names));
    mutation.setAttribute('argumentdefaults', JSON.stringify(defaults));
    mutation.setAttribute('warp', String(warp));
    return mutation;
}

export function showMakeBlock(mutator: Element | null, callback: (mutation: Element | null) => void): void {
    const parts = partsFromMutation(mutator);
    let warp = mutator?.getAttribute('warp') === 'true';

    const overlay = document.createElement('div');
    overlay.className = 'cw-modal-overlay';

    const dialog = document.createElement('form');
    dialog.className = 'cw-modal cw-modal-wide';

    const title = document.createElement('h2');
    title.textContent = mutator?.getAttribute('proccode') ? 'Edit block' : 'Make a block';
    dialog.appendChild(title);

    const partsBox = document.createElement('div');
    partsBox.className = 'cw-parts';
    dialog.appendChild(partsBox);

    const error = document.createElement('p');
    error.className = 'cw-modal-error';
    dialog.appendChild(error);

    const render = () => {
        partsBox.replaceChildren();
        parts.forEach((part, index) => {
            const row = document.createElement('div');
            row.className = 'cw-part-row';

            const badge = document.createElement('span');
            badge.className = `cw-part-badge cw-part-${part.kind}`;
            badge.textContent = part.kind === 'label' ? 'text' : part.kind === 'input' ? 'input' : 'boolean';
            row.appendChild(badge);

            const field = document.createElement('input');
            field.type = 'text';
            field.value = part.text;
            field.placeholder = part.kind === 'label' ? 'Label text' : 'Argument name';
            field.addEventListener('input', () => {
                part.text = field.value;
            });
            row.appendChild(field);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '✕';
            remove.title = 'Remove';
            remove.addEventListener('click', () => {
                parts.splice(index, 1);
                render();
            });
            row.appendChild(remove);

            partsBox.appendChild(row);
        });
    };
    render();

    const adders = document.createElement('div');
    adders.className = 'cw-modal-buttons cw-modal-left';
    const addPart = (kind: PartKind, label: string) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
            const count = parts.filter((p) => p.kind !== 'label').length;
            parts.push({
                kind,
                text: kind === 'label' ? '' : `arg${count + 1}`,
                id: kind === 'label' ? '' : newId(),
                def: kind === 'bool' ? false : '',
            });
            render();
            const inputs = partsBox.querySelectorAll('input');
            (inputs[inputs.length - 1] as HTMLInputElement | undefined)?.focus();
        });
        adders.appendChild(button);
    };
    addPart('label', '+ Text');
    addPart('input', '+ Input (number or text)');
    addPart('bool', '+ Boolean');
    dialog.appendChild(adders);

    const warpLabel = document.createElement('label');
    warpLabel.className = 'cw-modal-check';
    const warpBox = document.createElement('input');
    warpBox.type = 'checkbox';
    warpBox.checked = warp;
    warpBox.addEventListener('change', () => {
        warp = warpBox.checked;
    });
    warpLabel.append(warpBox, ' Run without screen refresh');
    dialog.appendChild(warpLabel);

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

    const close = (mutation: Element | null) => {
        overlay.remove();
        callback(mutation);
    };

    dialog.addEventListener('submit', (e) => {
        e.preventDefault();
        const mutation = mutationFromParts(parts, warp);
        if (!mutation) {
            error.textContent = 'A block needs at least one text label (its name).';
            return;
        }
        close(mutation);
    });
    cancel.addEventListener('click', () => close(null));
    // Keep keystrokes away from Blockly's global shortcuts.
    dialog.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close(null);
    });
    dialog.addEventListener('keyup', (e) => e.stopPropagation());
    dialog.addEventListener('keypress', (e) => e.stopPropagation());

    window.setTimeout(() => {
        const first = partsBox.querySelector('input') as HTMLInputElement | null;
        first?.focus();
        first?.select();
    }, 50);
}