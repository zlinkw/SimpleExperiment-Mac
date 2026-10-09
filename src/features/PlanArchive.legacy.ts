// @ts-nocheck
export function normalizePlanConfigReference(value) {
    return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function planYamlScalarTokens(planText, keyPattern) {
    const text = String(planText || "");
    const tokens = [];
    let quote = "";
    let escaped = false;
    let comment = false;
    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (comment) {
            if (ch === "\n")
                comment = false;
            continue;
        }
        if (quote) {
            if (quote === "'" && ch === "'" && text[index + 1] === "'") {
                index += 1;
                continue;
            }
            if (escaped) {
                escaped = false;
                continue;
            }
            if (quote === '"' && ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote)
                quote = "";
            continue;
        }
        if (ch === "#") {
            comment = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        const before = index > 0 ? text[index - 1] : "";
        if (before && !/[\s{\[,]/.test(before))
            continue;
        const keyMatch = text.slice(index).match(keyPattern);
        if (!keyMatch)
            continue;
        const key = keyMatch[1].toLowerCase();
        let cursor = index + keyMatch[1].length;
        if (/[A-Za-z0-9_.-]/.test(text[cursor] || ""))
            continue;
        while (text[cursor] === " " || text[cursor] === "\t")
            cursor += 1;
        if (text[cursor] !== ":")
            continue;
        cursor += 1;
        while (text[cursor] === " " || text[cursor] === "\t")
            cursor += 1;
        if (!text[cursor] || /[\r\n{\[>|]/.test(text[cursor]))
            continue;
        let start = cursor;
        let end = cursor;
        if (text[cursor] === '"' || text[cursor] === "'") {
            const scalarQuote = text[cursor];
            start = cursor + 1;
            end = start;
            let scalarEscaped = false;
            while (end < text.length) {
                const valueCh = text[end];
                if (scalarQuote === "'" && valueCh === "'" && text[end + 1] === "'") {
                    end += 2;
                    continue;
                }
                if (scalarEscaped) {
                    scalarEscaped = false;
                    end += 1;
                    continue;
                }
                if (scalarQuote === '"' && valueCh === "\\") {
                    scalarEscaped = true;
                    end += 1;
                    continue;
                }
                if (valueCh === scalarQuote)
                    break;
                end += 1;
            }
            if (end >= text.length)
                continue;
        }
        else {
            while (end < text.length && !/[\r\n#,}\]]/.test(text[end]))
                end += 1;
            while (end > start && /\s/.test(text[end - 1]))
                end -= 1;
        }
        tokens.push({ key, value: text.slice(start, end), start, end });
        index = Math.max(index, end);
    }
    return tokens;
}

function isConfigFileReference(value) {
    const normalized = normalizePlanConfigReference(value);
    return Boolean(normalized && !/[{}$]/.test(normalized) && /\.(?:ya?ml|json|py)$/i.test(normalized));
}

function isStaticCommandConfigReference(value) {
    const normalized = normalizePlanConfigReference(value);
    return isConfigFileReference(normalized) && !/^(?:[A-Za-z]:\/|\/)/.test(normalized);
}

export function planConfigScalarTokens(planText) {
    return planYamlScalarTokens(planText, /^(base_config|config)/i)
        .map((token) => ({ ...token, value: normalizePlanConfigReference(token.value) }))
        .filter((token) => isConfigFileReference(token.value));
}

function planCommandBlockSpans(planText) {
    const text = String(planText || "");
    const lines = [];
    const offsets = [];
    const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
    let lineMatch;
    while ((lineMatch = linePattern.exec(text))) {
        if (!lineMatch[0] && lineMatch.index >= text.length)
            break;
        offsets.push(lineMatch.index);
        lines.push(lineMatch[0].replace(/(?:\r\n|\n|\r)$/, ""));
    }
    const spans = [];
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^(\s*)(?:-\s*)?(train_command|trainCommand|test_command|testCommand|command)\s*:\s*([|>][+-]?\d*)\s*(?:#.*)?$/);
        if (!match)
            continue;
        const baseIndent = match[1].length;
        let first = index + 1;
        while (first < lines.length && !lines[first].trim())
            first += 1;
        if (first >= lines.length)
            continue;
        const firstIndent = lines[first].match(/^\s*/)?.[0].length || 0;
        if (firstIndent <= baseIndent)
            continue;
        let endLine = first;
        while (endLine < lines.length) {
            if (lines[endLine].trim()) {
                const indent = lines[endLine].match(/^\s*/)?.[0].length || 0;
                if (indent <= baseIndent)
                    break;
            }
            endLine += 1;
        }
        const start = offsets[first];
        const end = endLine < lines.length ? offsets[endLine] : text.length;
        spans.push({ key: match[2].toLowerCase(), value: text.slice(start, end), start, end });
        index = Math.max(index, endLine - 1);
    }
    return spans;
}

function planCommandLineSpans(planText) {
    const text = String(planText || "");
    const spans = [];
    const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
    let lineMatch;
    while ((lineMatch = linePattern.exec(text))) {
        if (!lineMatch[0] && lineMatch.index >= text.length)
            break;
        const line = lineMatch[0].replace(/(?:\r\n|\n|\r)$/, "");
        const match = line.match(/^(\s*(?:-\s*)?)(train_command|trainCommand|test_command|testCommand|command)\s*:\s*(.*)$/);
        if (!match || /^[|>][+-]?\d*\s*(?:#.*)?$/.test(match[3].trim()))
            continue;
        const valueOffset = line.length - match[3].length;
        let localStart = valueOffset;
        let localEnd = line.length;
        while (localStart < localEnd && /\s/.test(line[localStart]))
            localStart += 1;
        if (line[localStart] === '"' || line[localStart] === "'") {
            const quote = line[localStart];
            localStart += 1;
            localEnd = localStart;
            let escaped = false;
            while (localEnd < line.length) {
                const ch = line[localEnd];
                if (quote === "'" && ch === "'" && line[localEnd + 1] === "'") {
                    localEnd += 2;
                    continue;
                }
                if (escaped) {
                    escaped = false;
                    localEnd += 1;
                    continue;
                }
                if (quote === '"' && ch === "\\") {
                    escaped = true;
                    localEnd += 1;
                    continue;
                }
                if (ch === quote)
                    break;
                localEnd += 1;
            }
        }
        else {
            let quote = "";
            for (let index = localStart; index < localEnd; index += 1) {
                const ch = line[index];
                if ((ch === '"' || ch === "'") && line[index - 1] !== "\\")
                    quote = quote === ch ? "" : quote || ch;
                if (ch === "#" && !quote) {
                    localEnd = index;
                    break;
                }
            }
            while (localEnd > localStart && /\s/.test(line[localEnd - 1]))
                localEnd -= 1;
        }
        if (localEnd > localStart)
            spans.push({ key: match[2].toLowerCase(), value: line.slice(localStart, localEnd), start: lineMatch.index + localStart, end: lineMatch.index + localEnd });
    }
    return spans;
}

function commandMatchIsCommented(value, index) {
    const lineStart = value.lastIndexOf("\n", index) + 1;
    const prefix = value.slice(lineStart, index);
    let quote = "";
    let escaped = false;
    for (const ch of prefix) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\" && quote) {
            escaped = true;
            continue;
        }
        if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
            quote = quote === ch ? "" : ch;
            continue;
        }
        if (ch === "#" && !quote)
            return true;
    }
    return false;
}

function commandConfigTokensForSpan(span) {
    const patterns = [
        /(?:^|[\s;&|])--(?:base[-_]config|config(?:[-_](?:file|path))?|cfg)(?:\s*=\s*|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi,
        /(?:^|[\s;&|])(?:base_config|config|cfg)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi,
    ];
    const tokens = [];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(span.value))) {
            if (commandMatchIsCommented(span.value, match.index))
                continue;
            const raw = String(match[1] || match[2] || match[3] || "");
            const value = normalizePlanConfigReference(raw);
            if (!isStaticCommandConfigReference(value))
                continue;
            const localStart = match.index + match[0].lastIndexOf(raw);
            tokens.push({ key: span.key, value, start: span.start + localStart, end: span.start + localStart + raw.length });
        }
    }
    return tokens;
}

export function planCommandConfigTokens(planText) {
    const scalarSpans = planYamlScalarTokens(planText, /^(train_command|trainCommand|test_command|testCommand|command)/);
    const spans = [...scalarSpans, ...planCommandLineSpans(planText), ...planCommandBlockSpans(planText)].sort((a, b) => a.start - b.start);
    const seen = new Set();
    return spans.flatMap(commandConfigTokensForSpan).filter((token) => {
        const key = `${token.start}:${token.end}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}

export function planStaticConfigReferences(planText) {
    return [...new Set([...planConfigScalarTokens(planText), ...planCommandConfigTokens(planText)].map((item) => item.value))];
}

export function planRuntimeConfigReferences(planText, mode = "train_test") {
    const normalized = String(mode || "train_test").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const commandTokens = planCommandConfigTokens(planText).filter((item) => {
        if (normalized === "train")
            return ["train_command", "traincommand", "command"].includes(item.key);
        if (["test", "eval", "evaluation"].includes(normalized))
            return ["test_command", "testcommand"].includes(item.key);
        return true;
    });
    return [...new Set([...planConfigScalarTokens(planText), ...commandTokens].map((item) => item.value))];
}

function stripPythonLineComment(value) {
    let quote = "";
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const ch = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\" && quote) {
            escaped = true;
            continue;
        }
        if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
            quote = quote === ch ? "" : ch;
            continue;
        }
        if (ch === "#" && !quote)
            return value.slice(0, index);
    }
    return value;
}

function pythonCodeMask(value) {
    const text = String(value || "");
    const out = [...text];
    let quote = "";
    let triple = false;
    let escaped = false;
    let comment = false;
    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (comment) {
            if (ch === "\n")
                comment = false;
            else
                out[index] = " ";
            continue;
        }
        if (quote) {
            if (ch !== "\n")
                out[index] = " ";
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\" && !triple) {
                escaped = true;
                continue;
            }
            if (triple && text.slice(index, index + 3) === quote.repeat(3)) {
                out[index] = out[index + 1] = out[index + 2] = " ";
                quote = "";
                triple = false;
                index += 2;
                continue;
            }
            if (!triple && ch === quote)
                quote = "";
            continue;
        }
        if (ch === "#") {
            out[index] = " ";
            comment = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            triple = text.slice(index, index + 3) === ch.repeat(3);
            out[index] = " ";
            if (triple) {
                out[index + 1] = out[index + 2] = " ";
                index += 2;
            }
        }
    }
    return out.join("");
}

function pythonModuleCandidates(moduleName, sourceFile) {
    const raw = String(moduleName || "").trim();
    if (!raw)
        return [];
    const relativePrefix = raw.match(/^\.+/)?.[0] || "";
    const sourceDir = normalizePlanConfigReference(sourceFile).split("/").slice(0, -1);
    if (relativePrefix) {
        for (let index = 1; index < relativePrefix.length; index += 1)
            sourceDir.pop();
    }
    else {
        sourceDir.length = 0;
    }
    const suffix = raw.slice(relativePrefix.length).split(".").filter(Boolean);
    const base = [...sourceDir, ...suffix].join("/");
    if (!base)
        return sourceDir.length ? [`${sourceDir.join("/")}/__init__.py`] : [];
    return [`${base}.py`, `${base}/__init__.py`];
}

export function pythonLocalImportReferences(source, sourceFile) {
    const code = pythonCodeMask(source).replace(/\\\s*\r?\n\s*/g, " ");
    const references = [];
    const add = (moduleName) => {
        const candidates = pythonModuleCandidates(moduleName, sourceFile);
        if (candidates.length)
            references.push({ module: moduleName, candidates });
    };
    for (const match of code.matchAll(/(?:^|\n)\s*import\s+([^\n;]+)/g)) {
        for (const part of splitPythonCallArguments(match[1])) {
            const moduleName = part.replace(/\s+as\s+[A-Za-z_]\w*\s*$/i, "").trim();
            if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(moduleName))
                add(moduleName);
        }
    }
    for (const match of code.matchAll(/\bfrom\s+(\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\.+)\s+import\s+(\([^)]*\)|[^\n;]+)/g)) {
        const moduleName = match[1];
        add(moduleName);
        const imported = match[2].replace(/[()]/g, "");
        for (const part of splitPythonCallArguments(imported)) {
            const name = part.replace(/\s+as\s+[A-Za-z_]\w*\s*$/i, "").trim();
            if (name !== "*" && /^[A-Za-z_]\w*$/.test(name))
                add(`${moduleName}${moduleName.endsWith(".") ? "" : "."}${name}`);
        }
    }
    const seen = new Set();
    return references.filter((item) => {
        const key = item.candidates.join("|");
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}

function pythonCallBody(text, openIndex) {
    let depth = 0;
    let quote = "";
    let triple = false;
    let escaped = false;
    for (let index = openIndex; index < text.length; index += 1) {
        const ch = text[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote) {
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (triple && text.slice(index, index + 3) === quote.repeat(3)) {
                quote = "";
                triple = false;
                index += 2;
                continue;
            }
            if (!triple && ch === quote)
                quote = "";
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            triple = text.slice(index, index + 3) === ch.repeat(3);
            if (triple)
                index += 2;
            continue;
        }
        if (ch === "(")
            depth += 1;
        else if (ch === ")") {
            depth -= 1;
            if (depth === 0)
                return { body: text.slice(openIndex + 1, index), end: index + 1 };
        }
    }
    return undefined;
}

function splitPythonCallArguments(value) {
    const out = [];
    let start = 0;
    let depth = 0;
    let quote = "";
    let triple = false;
    let escaped = false;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote) {
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (triple && text.slice(index, index + 3) === quote.repeat(3)) {
                quote = "";
                triple = false;
                index += 2;
                continue;
            }
            if (!triple && ch === quote)
                quote = "";
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            triple = text.slice(index, index + 3) === ch.repeat(3);
            if (triple)
                index += 2;
            continue;
        }
        if ("([{".includes(ch))
            depth += 1;
        else if (")]}".includes(ch))
            depth -= 1;
        else if (ch === "," && depth === 0) {
            out.push(text.slice(start, index).trim());
            start = index + 1;
        }
    }
    const tail = text.slice(start).trim();
    if (tail)
        out.push(tail);
    return out.filter(Boolean);
}

function pythonKeywordArgument(part) {
    const match = String(part || "").match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
    return match ? { key: match[1], value: match[2].trim() } : undefined;
}

function pythonQuotedLiteral(value) {
    const match = String(value || "").trim().match(/^([rRuUbBfF]{0,2})(["'])([\s\S]*)\2$/);
    if (!match || /[fFbB]/.test(match[1]))
        return undefined;
    if (/[rR]/.test(match[1]))
        return match[3];
    if (/\\(?![\\"'])/.test(match[3]))
        return undefined;
    return match[3].replace(/\\([\\"'])/g, "$1");
}

function splitPythonMappingItem(value) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote) {
            if (ch === "\\")
                escaped = true;
            else if (ch === quote)
                quote = "";
            continue;
        }
        if (ch === '"' || ch === "'")
            quote = ch;
        else if ("([{".includes(ch))
            depth += 1;
        else if (")]}".includes(ch))
            depth -= 1;
        else if (ch === ":" && depth === 0)
            return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
    }
    return undefined;
}

function pythonStaticLiteral(value, constants = new Map()) {
    const text = String(value || "").trim();
    if (constants.has(text))
        return { known: true, value: constants.get(text), resolvedFrom: "module_constant" };
    const quoted = pythonQuotedLiteral(text);
    if (quoted !== undefined)
        return { known: true, value: quoted };
    if (/^(?:true|false)$/i.test(text))
        return { known: true, value: text.toLowerCase() === "true" };
    if (/^none$/i.test(text))
        return { known: true, value: null };
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))
        return { known: true, value: Number(text) };
    if (/^[\[(][\s\S]*[\])]$/.test(text)) {
        const items = splitPythonCallArguments(text.slice(1, -1)).map((item) => pythonStaticLiteral(item, constants));
        if (items.every((item) => item.known))
            return { known: true, value: items.map((item) => item.value) };
    }
    if (/^\{[\s\S]*\}$/.test(text)) {
        const body = text.slice(1, -1).trim();
        if (!body)
            return { known: true, value: {} };
        const pairs = splitPythonCallArguments(body).map(splitPythonMappingItem);
        if (pairs.every(Boolean)) {
            const entries = pairs.map(([key, itemValue]) => [pythonStaticLiteral(key, constants), pythonStaticLiteral(itemValue, constants)]);
            if (entries.every(([key, itemValue]) => key.known && itemValue.known))
                return { known: true, value: Object.fromEntries(entries.map(([key, itemValue]) => [String(key.value), itemValue.value])) };
        }
    }
    return { known: false };
}

function pythonStaticModuleConstants(source) {
    const constants = new Map();
    for (const line of String(source || "").split(/\r?\n/).map(stripPythonLineComment)) {
        const match = line.match(/^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(.+?)\s*$/);
        if (!match)
            continue;
        const literal = pythonStaticLiteral(match[2], constants);
        if (literal.known)
            constants.set(match[1], literal.value);
    }
    return constants;
}

function pythonExpressionIsSuppress(value) {
    return /^(?:argparse\s*\.\s*)?SUPPRESS$/.test(String(value || "").trim());
}

function pythonNargsKind(value) {
    const text = String(value || "").trim();
    if (/^["']\?["']$|^(?:argparse\s*\.\s*)?OPTIONAL$/.test(text))
        return "optional";
    if (/^["']\*["']$|^(?:argparse\s*\.\s*)?(?:ZERO_OR_MORE|REMAINDER)$/.test(text))
        return "zero_or_more";
    return "required";
}

export function pythonCliParameterAudit(source) {
    const text = String(source || "").split(/\r?\n/).map(stripPythonLineComment).join("\n");
    const code = pythonCodeMask(text);
    const moduleConstants = pythonStaticModuleConstants(source);
    const calls = [];
    const pattern = /\b(?:(?:([A-Za-z_]\w*)\s*\.)?(ArgumentParser|add_argument|set_defaults|add_parser|add_subparsers|add_argument_group|add_mutually_exclusive_group)|click\.(option|argument)|typer\.(Option|Argument))\s*\(/g;
    let match;
    while ((match = pattern.exec(code))) {
        const openIndex = code.indexOf("(", match.index);
        const parsed = pythonCallBody(text, openIndex);
        if (!parsed)
            continue;
        const token = match[2] || match[3] || match[4] || "";
        const framework = match[3] ? "click" : match[4] ? "typer" : "argparse";
        const before = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index);
        const assignedReceiver = ["ArgumentParser", "add_parser", "add_subparsers", "add_argument_group", "add_mutually_exclusive_group"].includes(token) ? before.match(/([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_]\w*\s*\.\s*)?$/)?.[1] || "" : "";
        calls.push({ token, framework, ownerReceiver: match[1] || "", assignedReceiver, receiver: token === "ArgumentParser" || token === "add_parser" ? assignedReceiver : (match[1] || ""), body: parsed.body, index: match.index, expression: `${match[0].slice(0, match[0].indexOf("(")).trim()}(${parsed.body})` });
        pattern.lastIndex = parsed.end;
    }
    const groupParents = new Map();
    for (const group of code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\.\s*(?:add_argument_group|add_mutually_exclusive_group)\s*\(/g))
        groupParents.set(group[1], group[2]);
    const resolvedReceiver = (value) => {
        let current = String(value || "");
        const seen = new Set();
        while (groupParents.has(current) && !seen.has(current)) {
            seen.add(current);
            current = groupParents.get(current);
        }
        return current;
    };
    const setDefaults = new Map();
    const unresolvedDeclarations = [];
    for (const call of calls.filter((item) => item.token === "set_defaults")) {
        const receiver = resolvedReceiver(call.receiver);
        for (const part of splitPythonCallArguments(call.body)) {
            const keyword = pythonKeywordArgument(part);
            if (keyword) {
                const key = `${receiver}:${keyword.key}`;
                const declarations = setDefaults.get(key) || [];
                declarations.push({ value: keyword.value, line: text.slice(0, call.index).split("\n").length, index: call.index, declarationExpression: call.expression });
                setDefaults.set(key, declarations);
            }
            else
                unresolvedDeclarations.push({ framework: "argparse", line: text.slice(0, call.index).split("\n").length, declarationExpression: call.expression, reason: "dynamic_set_defaults" });
        }
    }
    const argumentDefaults = new Map();
    for (const call of calls.filter((item) => ["ArgumentParser", "add_parser"].includes(item.token))) {
        const value = splitPythonCallArguments(call.body).map(pythonKeywordArgument).filter(Boolean).find((part) => part.key === "argument_default")?.value;
        if (value !== undefined && call.receiver)
            argumentDefaults.set(resolvedReceiver(call.receiver), value);
    }
    const parserDeclarations = calls.filter((item) => ["ArgumentParser", "add_parser", "add_subparsers", "add_argument_group", "add_mutually_exclusive_group", "set_defaults"].includes(item.token)).map((call) => {
        const parts = splitPythonCallArguments(call.body);
        return {
            kind: call.token,
            line: text.slice(0, call.index).split("\n").length,
            receiver: resolvedReceiver(call.receiver) || null,
            ownerReceiver: resolvedReceiver(call.ownerReceiver) || null,
            assignedReceiver: call.assignedReceiver || null,
            declarationExpression: call.expression,
            positionalArguments: parts.filter((part) => !pythonKeywordArgument(part)),
            keywordArguments: Object.fromEntries(parts.map(pythonKeywordArgument).filter(Boolean).map((item) => [item.key, item.value])),
        };
    });
    const out = [];
    const actionDefaultKeys = new Set();
    for (const call of calls.filter((item) => !["ArgumentParser", "set_defaults", "add_parser", "add_argument_group", "add_mutually_exclusive_group"].includes(item.token))) {
        const parts = splitPythonCallArguments(call.body);
        const keywords = new Map(parts.map(pythonKeywordArgument).filter(Boolean).map((item) => [item.key, item.value]));
        const positionalParts = parts.filter((part) => !pythonKeywordArgument(part));
        const isTyper = call.framework === "typer";
        const isTyperArgument = isTyper && call.token === "Argument";
        const isClickArgument = call.framework === "click" && call.token === "argument";
        const isSubparserSelector = call.framework === "argparse" && call.token === "add_subparsers";
        const before = text.slice(text.lastIndexOf("\n", call.index) + 1, call.index);
        const inferredName = before.match(/([A-Za-z_]\w*)\s*:\s*[^=]+?=\s*$/)?.[1] || "";
        let aliases = [];
        if (isTyper) {
            aliases = positionalParts.map(pythonQuotedLiteral).filter((item) => item !== undefined && item.startsWith("-"));
            if (!aliases.length && inferredName && !isTyperArgument)
                aliases = [`--${inferredName.replace(/_/g, "-")}`];
        }
        else {
            aliases = positionalParts.map(pythonQuotedLiteral).filter((item) => item !== undefined);
        }
        const flags = aliases.filter((item) => item.startsWith("-"));
        const positional = isSubparserSelector || isTyperArgument || isClickArgument || flags.length === 0;
        const explicitClickName = call.framework === "click" ? aliases.find((item) => !item.startsWith("-")) : "";
        const explicitDest = pythonQuotedLiteral(keywords.get("dest"));
        if (keywords.has("dest") && explicitDest === undefined)
            unresolvedDeclarations.push({ framework: call.framework, line: text.slice(0, call.index).split("\n").length, declarationExpression: call.expression, reason: "dynamic_dest" });
        if (positionalParts.some((part) => /^\*\*/.test(part)))
            unresolvedDeclarations.push({ framework: call.framework, line: text.slice(0, call.index).split("\n").length, declarationExpression: call.expression, reason: "dynamic_parameter_kwargs" });
        if (isSubparserSelector && (!explicitDest || pythonExpressionIsSuppress(keywords.get("dest"))))
            continue;
        const preferredFlag = flags.find((item) => item.startsWith("--")) || flags[0] || inferredName;
        const normalizedFlag = call.framework === "click" ? String(preferredFlag).split(/[\/;]/)[0] : preferredFlag;
        const name = String(explicitDest || explicitClickName || (positional ? (aliases[0] || inferredName) : normalizedFlag)).replace(/^-+/, "").replace(/-/g, "_").trim();
        if (!name) {
            unresolvedDeclarations.push({ framework: call.framework, line: text.slice(0, call.index).split("\n").length, declarationExpression: call.expression, reason: "dynamic_parameter_name" });
            continue;
        }
        let defaultExpression = keywords.get("default");
        let defaultSource = defaultExpression !== undefined ? "declaration" : "framework_implicit";
        if (isTyper && positionalParts.length) {
            const first = positionalParts[0];
            const firstLiteral = pythonQuotedLiteral(first);
            if (firstLiteral === undefined || !firstLiteral.startsWith("-")) {
                defaultExpression = first;
                defaultSource = first === "..." ? "required" : "declaration";
            }
        }
        if (defaultExpression === undefined && isTyper && keywords.has("default_factory")) {
            defaultExpression = `default_factory(${keywords.get("default_factory")})`;
            defaultSource = "default_factory";
        }
        const hasDeclarationDefault = defaultExpression !== undefined;
        const receiver = resolvedReceiver(call.receiver);
        const setDefaultKey = `${receiver}:${name}`;
        actionDefaultKeys.add(setDefaultKey);
        const matchingSetDefaults = setDefaults.get(setDefaultKey) || [];
        const laterSetDefault = [...matchingSetDefaults].reverse().find((item) => item.index > call.index);
        const earlierSetDefault = [...matchingSetDefaults].reverse().find((item) => item.index <= call.index);
        const effectiveSetDefault = laterSetDefault || (!hasDeclarationDefault && !isSubparserSelector ? earlierSetDefault : undefined);
        if (effectiveSetDefault) {
            defaultExpression = effectiveSetDefault.value;
            defaultSource = "set_defaults";
        }
        if (defaultExpression === undefined && !isSubparserSelector && argumentDefaults.has(receiver)) {
            defaultExpression = argumentDefaults.get(receiver);
            defaultSource = "argument_default";
        }
        if (defaultExpression === undefined && keywords.get("action")?.match(/["']store_true["']/)) {
            defaultExpression = "False";
            defaultSource = "action_implicit";
        }
        if (defaultExpression === undefined && keywords.get("action")?.match(/["']store_false["']/)) {
            defaultExpression = "True";
            defaultSource = "action_implicit";
        }
        if (defaultExpression === undefined && call.framework === "click" && keywords.get("count")?.match(/^True$/i)) {
            defaultExpression = "0";
            defaultSource = "count_implicit";
        }
        if (defaultExpression === undefined && call.framework === "click" && keywords.get("multiple")?.match(/^True$/i)) {
            defaultExpression = "()";
            defaultSource = "multiple_implicit";
        }
        if (defaultExpression === undefined && call.framework === "click" && keywords.get("is_flag")?.match(/^True$/i)) {
            defaultExpression = "False";
            defaultSource = "flag_implicit";
        }
        if (defaultExpression === undefined) {
            const nargsKind = pythonNargsKind(keywords.get("nargs"));
            if (keywords.get("required")?.match(/^True$/i) || isTyper || (isClickArgument && !keywords.get("required")?.match(/^False$/i)) || (call.framework === "argparse" && positional && !isSubparserSelector && nargsKind === "required")) {
                defaultExpression = "...";
                defaultSource = "required";
            }
            else if (call.framework === "argparse" && positional && nargsKind === "zero_or_more") {
                defaultExpression = "[]";
                defaultSource = "nargs_implicit";
            }
            else {
                defaultExpression = "None";
                defaultSource = "framework_implicit";
            }
        }
        const suppressed = pythonExpressionIsSuppress(defaultExpression);
        const literal = defaultExpression === undefined || defaultExpression === "..." || suppressed ? { known: false } : pythonStaticLiteral(defaultExpression, moduleConstants);
        const keywordArguments = Object.fromEntries(keywords);
        out.push({
            name,
            aliases,
            positional,
            framework: call.framework,
            line: text.slice(0, call.index).split("\n").length,
            receiver: receiver || null,
            declarationExpression: call.expression,
            keywordArguments,
            defaultExpression: defaultExpression ?? null,
            defaultSource,
            defaultResolved: suppressed || Boolean(literal.known),
            ...(suppressed ? { suppressed: true } : {}),
            ...(literal.known ? { defaultValue: literal.value } : {}),
            ...(literal.resolvedFrom ? { defaultResolvedFrom: literal.resolvedFrom } : {}),
            ...(keywords.has("required") ? { requiredExpression: keywords.get("required") } : {}),
            ...(keywords.has("dest") ? { destExpression: keywords.get("dest") } : {}),
            ...(keywords.has("type") ? { typeExpression: keywords.get("type") } : {}),
            ...(keywords.has("action") ? { actionExpression: keywords.get("action") } : {}),
            ...(keywords.has("choices") ? { choicesExpression: keywords.get("choices") } : {}),
            ...(keywords.has("nargs") ? { nargsExpression: keywords.get("nargs") } : {}),
            ...(keywords.has("const") ? { constExpression: keywords.get("const") } : {}),
            ...(keywords.has("envvar") ? { envvarExpression: keywords.get("envvar") } : {}),
        });
    }
    for (const [key, declarations] of setDefaults) {
        if (actionDefaultKeys.has(key))
            continue;
        const item = declarations[declarations.length - 1];
        const separator = key.indexOf(":");
        const receiver = key.slice(0, separator);
        const name = key.slice(separator + 1);
        const literal = pythonStaticLiteral(item.value, moduleConstants);
        out.push({
            name,
            aliases: [],
            positional: false,
            framework: "argparse",
            line: item.line,
            receiver: receiver || null,
            declarationExpression: item.declarationExpression,
            keywordArguments: { [name]: item.value },
            namespaceDefault: true,
            defaultExpression: item.value,
            defaultSource: "set_defaults_namespace",
            defaultResolved: Boolean(literal.known),
            ...(literal.known ? { defaultValue: literal.value } : {}),
            ...(literal.resolvedFrom ? { defaultResolvedFrom: literal.resolvedFrom } : {}),
        });
    }
    const dynamicDefaults = out.filter((item) => item.defaultExpression && item.defaultExpression !== "..." && !item.defaultResolved).map((item) => ({ name: item.name, framework: item.framework, line: item.line, defaultExpression: item.defaultExpression }));
    const parserFeatures = [];
    if (calls.filter((item) => ["ArgumentParser", "add_parser"].includes(item.token)).some((item) => splitPythonCallArguments(item.body).map(pythonKeywordArgument).filter(Boolean).some((part) => part.key === "parents")))
        parserFeatures.push("argparse_parents_require_source_review");
    if (/\b(?:parse_args|parse_known_args|parse_intermixed_args|parse_known_intermixed_args)\s*\([^)]*\bnamespace\s*=/s.test(code))
        parserFeatures.push("argparse_namespace_defaults_require_runtime_evidence");
    if (/\badd_(?:argument_group|mutually_exclusive_group)\s*\([^)]*\)\s*\.\s*add_argument\s*\(/s.test(code))
        parserFeatures.push("argparse_chained_group_requires_source_review");
    if (/\btyper\.run\s*\(|@\s*[A-Za-z_]\w*\.command\s*\(/.test(code))
        parserFeatures.push("typer_plain_function_parameters_require_source_review");
    if (/\bclick\.(?:password_option|confirmation_option|version_option|help_option)\s*\(/.test(code))
        parserFeatures.push("click_convenience_decorators_require_source_review");
    if (/\bfrom\s+click\s+import\s+[^\n]*(?:option|argument)\b/.test(code))
        parserFeatures.push("click_imported_decorators_require_source_review");
    if (/\bfrom\s+typer\s+import\s+[^\n]*(?:Option|Argument)\b/.test(code) || /\bAnnotated\s*\[[^\]]*typer\.(?:Option|Argument)\s*\(/s.test(code))
        parserFeatures.push("typer_annotated_or_imported_parameters_require_source_review");
    if (calls.filter((item) => ["ArgumentParser", "add_parser"].includes(item.token)).some((item) => splitPythonCallArguments(item.body).map(pythonKeywordArgument).filter(Boolean).some((part) => part.key === "prefix_chars" && pythonQuotedLiteral(part.value) !== "-")))
        parserFeatures.push("argparse_nonstandard_prefix_chars_require_source_review");
    if (/\b(?:parse_args|parse_known_args|parse_intermixed_args|parse_known_intermixed_args)\s*\(/.test(code) && !out.some((item) => item.framework === "argparse"))
        parserFeatures.push("argparse_no_local_parameter_declarations");
    return { parameters: out, parserDeclarations, unresolvedDeclarations, dynamicDefaults, parserFeatures };
}

export function pythonCliParameterDeclarations(source) {
    return pythonCliParameterAudit(source).parameters;
}

const restoreOutputDirKeyPattern = /^(output_dir|outputDir|result_dir|resultDir|results_dir|resultsDir|work_dir|workDir|workdir|save_dir|saveDir|log_dir|logDir|sweep_dir|sweepDir|default_root_dir|defaultRootDir|run_dir|runDir)/;
const restoreResultFileKeyPattern = /^(result_csv|resultCsv|results_csv|resultsCsv|metrics_csv|metricsCsv|summary_csv|summaryCsv|output_csv|outputCsv|result_json|resultJson|metrics_json|metricsJson|summary_txt|summaryTxt|log_file|logFile|expectedResults|expected_results|resultFiles|result_files)/;
function restoreOutputNamespace(planVersion) {
    const version = String(planVersion || "1").replace(/^v/i, "").replace(/[^0-9A-Za-z_.-]+/g, "") || "1";
    return `__restored_v${version}`;
}
function restoreVersionedPath(value, planVersion, kind) {
    const original = String(value || "").trim();
    if (!original || /^(?:[A-Za-z]:[\\/]|\/)/.test(original) || /__restored_v[0-9A-Za-z_.-]+/i.test(original))
        return original;
    if (kind === "result" && /\{(?:output_dir|outputDir|result_csv|resultCsv)\}|\$(?:\{)?(?:output_dir|outputDir|result_csv|resultCsv)/.test(original))
        return original;
    if (kind === "dir" && /\$(?!\{)/.test(original))
        return original;
    const namespace = restoreOutputNamespace(planVersion);
    const normalized = original.replace(/\\/g, "/");
    if (kind === "dir")
        return `${normalized.replace(/\/+$/, "")}/${namespace}`;
    const match = normalized.match(/^(.*?)(\.[A-Za-z0-9]{1,12})$/);
    return match ? `${match[1]}${namespace}${match[2]}` : `${normalized.replace(/\/+$/, "")}/${namespace}`;
}
function expandRestoreScalarToken(planText, token) {
    const text = String(planText || "");
    const quote = text[token.start - 1];
    if ((quote === '"' || quote === "'") && text[token.end] === quote)
        return token;
    let end = token.start;
    while (end < text.length) {
        const placeholder = text.slice(end).match(/^\{[A-Za-z_][A-Za-z0-9_.-]*\}/);
        if (placeholder) {
            end += placeholder[0].length;
            continue;
        }
        if (/[\r\n#,}\]]/.test(text[end]))
            break;
        end += 1;
    }
    while (end > token.start && /\s/.test(text[end - 1]))
        end -= 1;
    return { ...token, value: text.slice(token.start, end), end };
}
function planRestoreOutputScalarTokens(planText, planVersion) {
    return [
        ...planYamlScalarTokens(planText, restoreOutputDirKeyPattern).map((token) => expandRestoreScalarToken(planText, token)).map((token) => ({ ...token, restored: restoreVersionedPath(token.value, planVersion, "dir") })),
        ...planYamlScalarTokens(planText, restoreResultFileKeyPattern).map((token) => expandRestoreScalarToken(planText, token)).map((token) => ({ ...token, restored: restoreVersionedPath(token.value, planVersion, "result") })),
    ].filter((token) => token.restored && token.restored !== token.value);
}
function commandRestoreOutputTokensForSpan(span, planVersion) {
    const patterns = [
        { kind: "dir", pattern: /(?:^|[\s;&|])--(?:output|out|output[-_]dir|out[-_]dir|work[-_]dir|workdir|save[-_]dir|log[-_]dir|run[-_]dir|result[-_]dir|results[-_]dir|default[-_]root[-_]dir)(?:\s*=\s*|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi },
        { kind: "result", pattern: /(?:^|[\s;&|])--(?:result[-_]csv|results[-_]csv|metrics[-_]csv|summary[-_]csv|output[-_]csv|result[-_]json|metrics[-_]json|summary[-_]txt|log[-_]file)(?:\s*=\s*|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi },
        { kind: "dir", pattern: /(?:^|[\s;&|])(?:output_dir|outputDir|out_dir|work_dir|workDir|workdir|save_dir|saveDir|log_dir|logDir|run_dir|runDir|result_dir|resultDir|results_dir|resultsDir|default_root_dir|defaultRootDir|hydra\.run\.dir|hydra\.sweep\.dir|logger\.save_dir|trainer\.default_root_dir)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi },
        { kind: "result", pattern: /(?:^|[\s;&|])(?:result_csv|resultCsv|results_csv|resultsCsv|metrics_csv|metricsCsv|summary_csv|summaryCsv|output_csv|outputCsv|result_json|resultJson|metrics_json|metricsJson|summary_txt|summaryTxt|log_file|logFile)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi },
    ];
    const tokens = [];
    for (const item of patterns) {
        let match;
        while ((match = item.pattern.exec(span.value))) {
            if (commandMatchIsCommented(span.value, match.index))
                continue;
            const raw = String(match[1] || match[2] || match[3] || "");
            const restored = restoreVersionedPath(raw, planVersion, item.kind);
            if (!restored || restored === raw)
                continue;
            const localStart = match.index + match[0].lastIndexOf(raw);
            tokens.push({ key: span.key, value: raw, restored, start: span.start + localStart, end: span.start + localStart + raw.length });
        }
    }
    return tokens;
}
function planCommandRestoreOutputTokens(planText, planVersion) {
    const scalarSpans = planYamlScalarTokens(planText, /^(train_command|trainCommand|test_command|testCommand|command)/);
    const spans = [...scalarSpans, ...planCommandLineSpans(planText), ...planCommandBlockSpans(planText)].sort((a, b) => a.start - b.start);
    const seen = new Set();
    return spans.flatMap((span) => commandRestoreOutputTokensForSpan(span, planVersion)).filter((token) => {
        const key = `${token.start}:${token.end}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function isRestoreResultPath(value) {
    const text = String(value || "").trim();
    return Boolean(text && (/\{(?:output_dir|outputDir|result_csv|resultCsv)\}/.test(text) || /\.(?:csv|json|txt|md|log|out)$/i.test(text)));
}
function planRestoreResultListTokens(planText, planVersion) {
    const text = String(planText || "");
    const lines = [];
    const offsets = [];
    const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
    let lineMatch;
    while ((lineMatch = linePattern.exec(text))) {
        if (!lineMatch[0] && lineMatch.index >= text.length)
            break;
        offsets.push(lineMatch.index);
        lines.push(lineMatch[0].replace(/(?:\r\n|\n|\r)$/, ""));
    }
    const tokens = [];
    for (let index = 0; index < lines.length; index += 1) {
        const container = lines[index].match(/^(\s*)(?:-\s*)?(?:expectedResults|expected_results|resultFiles|result_files)\s*:\s*(?:#.*)?$/);
        if (!container)
            continue;
        const baseIndent = container[1].length;
        for (let child = index + 1; child < lines.length; child += 1) {
            const line = lines[child];
            if (!line.trim())
                continue;
            const indent = line.match(/^\s*/)?.[0].length || 0;
            if (indent <= baseIndent)
                break;
            const keyed = line.match(/^\s*(?:-\s*)?(?:path|file|result|resultFile|result_file|result_csv|resultCsv|results_csv|resultsCsv|metrics_csv|metricsCsv|summary_csv|summaryCsv|output_csv|outputCsv|result_json|resultJson|metrics_json|metricsJson|summary_txt|summaryTxt|log_file|logFile)\s*:\s*(?:"([^"]+)"|'([^']+)'|([^#]+?))\s*(?:#.*)?$/);
            const scalar = keyed ? undefined : line.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^#]+?))\s*(?:#.*)?$/);
            const match = keyed || scalar;
            if (!match)
                continue;
            const raw = String(match[1] || match[2] || match[3] || "").trim();
            if (!isRestoreResultPath(raw))
                continue;
            const restored = restoreVersionedPath(raw, planVersion, "result");
            if (!restored || restored === raw)
                continue;
            const localStart = line.lastIndexOf(raw);
            tokens.push({ key: "expectedresults", value: raw, restored, start: offsets[child] + localStart, end: offsets[child] + localStart + raw.length });
        }
    }
    return tokens;
}

export function restorePlanText(planText, context) {
    const outputNamespace = restoreOutputNamespace(context.planVersion);
    const header = [
        `# SimpleExperiment restore version: v${context.planVersion}`,
        `# SimpleExperiment original plan: ${context.originalPlanFile}`,
        `# SimpleExperiment archived source: ${context.archivedPlanFile}`,
        `# SimpleExperiment result scope: ${context.restoredFile}`,
        `# SimpleExperiment restored output namespace: ${outputNamespace}`,
        ...(context.restoredEnvironmentDir ? [`# SimpleExperiment restored environment: ${context.restoredEnvironmentDir}`] : []),
        ...(context.restoredParameterDir ? [`# SimpleExperiment restored parameters: ${context.restoredParameterDir}`] : []),
    ].join("\n") + "\n";
    let rewritten = String(planText || "");
    const configReplacements = [...planConfigScalarTokens(rewritten), ...planCommandConfigTokens(rewritten)]
        .map((token) => ({ ...token, restored: context.configPathMap.get(token.value) }))
        .filter((token) => Boolean(token.restored));
    const outputReplacements = [...planRestoreOutputScalarTokens(rewritten, context.planVersion), ...planCommandRestoreOutputTokens(rewritten, context.planVersion), ...planRestoreResultListTokens(rewritten, context.planVersion)];
    const replacements = [...configReplacements, ...outputReplacements]
        .sort((a, b) => b.start - a.start);
    for (const token of replacements)
        rewritten = `${rewritten.slice(0, token.start)}${token.restored}${rewritten.slice(token.end)}`;
    return header + rewritten;
}
