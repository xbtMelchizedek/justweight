import { getAgentRoute } from "./catalog.js";
import { iconSources } from "./generated-icons.js";
export * from "./catalog.js";
const ownerAndRepo = /^[\w.-]+\/[\w.-]+$/u;
const githubRepo = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/iu;
const hiddenPathCharacters = /[\p{Cc}\p{Cf}]/u;
const qualifiedSkill = /^[\w.@-]+(?:\/[\w.@-]+)+$/u;
const invalidSessionId = /[\\/\u0000]|\.\./u;
function parseServerUrl(value) {
    try {
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash)
            return null;
        return url.protocol === "https:" || url.protocol === "http:" ? url : null;
    }
    catch {
        return null;
    }
}
function getOpenCodeOrigin(url) {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.pathname === "/" && (url.protocol === "https:" || local) ? url.origin : null;
}
function encodeDirectory(directory) {
    const bytes = new TextEncoder().encode(directory);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
function isLocalPath(path) {
    return (/^\/(?!\/)|^[a-z]:[\\/]/iu.test(path)) &&
        !hiddenPathCharacters.test(path) &&
        !path.split(/[\\/]/u).includes("..");
}
/**
 * Build an agent URL. Returns null for an unavailable route, invalid input,
 * or a route that requires an explicit opt-in.
 */
export function getAgentLink(agent, platform, options = {}) {
    const route = getAgentRoute(agent, platform);
    if (!route)
        return null;
    const { allowExperimental: _allowExperimental, allowSend: _allowSend, browserOnly, ...fields } = options;
    for (const [field, value] of Object.entries(fields)) {
        if (value !== undefined && (typeof value !== "string" || !Object.hasOwn(route.fields ?? {}, field))) {
            return null;
        }
    }
    if (agent === "grok-bot" && fields.prompt) {
        fields.prompt = fields.prompt.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
    }
    if (fields.prompt && route.promptLimit) {
        const promptLength = route.promptLimitUnit === "grapheme"
            ? Array.from(new Intl.Segmenter().segment(fields.prompt)).length
            : fields.prompt.length;
        if (promptLength > route.promptLimit)
            return null;
    }
    if (fields.repo && !fields.cwd && !ownerAndRepo.test(fields.repo) &&
        (agent !== "t3-code" || !githubRepo.test(fields.repo)))
        return null;
    if ([fields.cwd, fields.path, fields.directory, fields.folder].some((path) => path !== undefined && !isLocalPath(path))) {
        return null;
    }
    if (fields.model && !fields.provider)
        return null;
    if (fields.mode && fields.mode !== "plan" && fields.mode !== "code")
        return null;
    if (fields.branch && (!fields.repo || hiddenPathCharacters.test(fields.branch)))
        return null;
    if (fields.session && invalidSessionId.test(fields.session))
        return null;
    const fragment = browserOnly && route.browserOnlyFragment
        ? `#${encodeURIComponent(route.browserOnlyFragment)}`
        : "";
    if (route.launchUrl && Object.values(fields).every((value) => !value))
        return `${route.launchUrl}${fragment}`;
    if ((route.experimental && !options.allowExperimental) ||
        (route.behavior === "send" && !options.allowSend))
        return null;
    if (route.required?.some((field) => !fields[field]?.trim()))
        return null;
    let baseUrl = route.url;
    if (fields.server) {
        const server = parseServerUrl(fields.server);
        if (!server)
            return null;
        if (agent === "opencode") {
            const origin = getOpenCodeOrigin(server);
            if (!origin)
                return null;
            baseUrl = fields.directory ? `${origin}/${encodeDirectory(fields.directory)}/session` : origin;
        }
        else if (agent === "t3-code") {
            if (server.pathname !== "/")
                return null;
            baseUrl = `${server.origin}/new`;
        }
        else {
            baseUrl = server.href;
        }
    }
    const query = [];
    for (const [field, parameter] of Object.entries(route.fields ?? {})) {
        if (!parameter)
            continue;
        if (field === "repo" && fields.cwd)
            continue;
        const value = fields[field];
        if (value !== undefined && value !== "") {
            const wellFormed = value.replace(/[\ud800-\udfff]/gu, "\ufffd");
            query.push(`${parameter}=${encodeURIComponent(wellFormed)}`);
        }
    }
    for (const [name, value] of Object.entries(route.query ?? {})) {
        query.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
    const parameters = query.length ? `?${query.join("&")}` : "";
    const url = `${baseUrl}${parameters}${fragment}`;
    return route.urlLimit && url.length > route.urlLimit ? null : url;
}
/** Open Hermes Desktop's install review for a qualified skill or a direct skill URL. */
export function getHermesSkillLink(identifier) {
    if (typeof identifier !== "string" || hiddenPathCharacters.test(identifier))
        return null;
    const skill = identifier.trim().replace(/[\ud800-\udfff]/gu, "\ufffd");
    const reference = skill.startsWith("well-known:") ? skill.slice("well-known:".length) : skill;
    const isQualified = qualifiedSkill.test(skill) && !skill.split("/").some((part) => part === "." || part === "..");
    if (!isQualified) {
        try {
            const url = new URL(reference);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
                return null;
        }
        catch {
            return null;
        }
    }
    return `hermes://skill/install?identifier=${encodeURIComponent(skill)}`;
}
/** Return a self-contained SVG URL for an agent with a bundled brand asset. */
export function getAgentIcon(agent) {
    return Object.hasOwn(iconSources, agent) ? iconSources[agent] ?? null : null;
}
