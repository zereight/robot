/**
 * The controls of an agent browser page: the scripts that list them, act on one, and read the
 * short state after an action (spec 007, "Browser details"). One listing script feeds the read
 * list, the unclear-target candidates and the pick-by-number, so the numbers always mean the
 * same control. Only the document of the main frame is seen: frames and shadow roots are not.
 */

/** The most controls that one listing holds. */
export const PAGE_CONTROLS_MAX = 200

/** The elements that the agent can use: links, buttons, fields, and what says it is one. */
const CONTROLS_QUERY =
  'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],' +
  '[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[role="switch"],' +
  '[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],' +
  '[role="option"],[contenteditable="true"]'

/**
 * The helpers that every control script starts with. They define `roleOf`, `labelOf` and
 * `listOf`. `listOf` gives the visible, enabled controls in document order, each with its
 * element for the act scripts; a script that answers must map them to plain data first.
 */
const CONTROLS_CORE = `
const roleOf = (el) => {
  const named = el.getAttribute && el.getAttribute("role");
  if (named) return named;
  const tag = el.tagName;
  if (tag === "A") return "link";
  if (tag === "BUTTON") return "button";
  if (tag === "SELECT") return "combobox";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "SUMMARY") return "button";
  if (tag === "OPTION") return "option";
  if (tag === "INPUT") {
    const kind = (el.type || "text").toLowerCase();
    if (kind === "checkbox") return "checkbox";
    if (kind === "radio") return "radio";
    if (kind === "submit" || kind === "button" || kind === "reset" || kind === "image") return "button";
    return "textbox";
  }
  if (el.isContentEditable) return "textbox";
  return tag.toLowerCase();
};
const SECURE_NAME = /pass(?:word|wd)?|passcode|otp|one.?time|verification|card.?(?:number|no)|cvv|cvc|secret|token|비밀번호|인증|카드번호/i;
const SECURE_AUTO = /cc-|one-time-code|current-password|new-password/i;
const isSecure = (el) => {
  if (!el || el.tagName !== "INPUT") return false;
  const kind = (el.type || "text").toLowerCase();
  if (kind === "password") return true;
  if (kind === "hidden" || kind === "checkbox" || kind === "radio" || kind === "submit" || kind === "button") return false;
  const auto = el.getAttribute("autocomplete") || "";
  if (SECURE_AUTO.test(auto)) return true;
  return SECURE_NAME.test([el.name, el.id, el.getAttribute("aria-label") || ""].join(" "));
};
const labelOf = (el) => {
  const aria = el.getAttribute && el.getAttribute("aria-label");
  if (aria) return aria.trim().split("\\n")[0].slice(0, 80);
  if (el.tagName === "SELECT") {
    const one = el.selectedOptions && el.selectedOptions[0];
    const name = (one && one.text) || el.getAttribute("name") || el.id || "select";
    return String(name).trim().slice(0, 80);
  }
  const raw =
    el.innerText ||
    (isSecure(el) ? "" : el.value) ||
    (el.getAttribute &&
      (el.getAttribute("placeholder") ||
        el.getAttribute("alt") ||
        el.getAttribute("name") ||
        el.getAttribute("title"))) ||
    el.id ||
    el.tagName.toLowerCase();
  return String(raw).trim().split("\\n")[0].slice(0, 80);
};
const visibleOf = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse";
};
const listOf = () => {
  const found = [];
  const all = document.querySelectorAll(${JSON.stringify(CONTROLS_QUERY)});
  for (const el of all) {
    if (el.disabled || !visibleOf(el)) continue;
    const r = el.getBoundingClientRect();
    found.push({
      el,
      role: roleOf(el),
      label: labelOf(el),
      x: Math.round(r.x),
      y: Math.round(r.y),
    });
    if (found.length >= ${PAGE_CONTROLS_MAX}) break;
  }
  return found;
};
`

/**
 * Keeps the errors of the page (script errors, failed loads of the page itself, rejected work)
 * in `window.__robotErrors`, up to 20. Runs before every action; a navigation wipes it and the
 * next action puts it back. Safe to run twice.
 */
const TRAP_ERRORS = `
if (!window.__robotErrors) {
  window.__robotErrors = [];
  const keep = (message) => {
    const list = window.__robotErrors;
    if (list && list.length < 20) list.push(String(message).slice(0, 200));
  };
  window.addEventListener("error", (event) => keep(event.message || "error"));
  window.addEventListener("unhandledrejection", (event) =>
    keep((event.reason && event.reason.message) || event.reason || "rejected"),
  );
}
`

/**
 * The part of an act script that finds the control. A plain number picks from the listing; anything
 * else is a CSS selector. A selector that fits more than one listed control gives up with up to 5
 * candidates; a fit outside the listing (a hidden control) keeps the old behaviour: the first fit.
 * It needs `target` and `list`, and sets `el`.
 */
const FIND_TARGET = `
let el = null;
if (/^\\d+$/.test(target)) {
  const found = list[Number(target) - 1];
  if (!found) return { ok: false, reason: "none" };
  el = found.el;
} else {
  let matches;
  try {
    matches = Array.from(document.querySelectorAll(target));
  } catch (bad) {
    return { ok: false, reason: "none" };
  }
  const at = new Map(list.map((entry, i) => [entry.el, i]));
  const listed = matches.filter((one) => at.has(one));
  if (listed.length > 1) {
    return {
      ok: false,
      reason: "many",
      total: listed.length,
      candidates: listed.slice(0, 5).map((one) => {
        const entry = list[at.get(one)];
        return { index: at.get(one) + 1, role: entry.role, label: entry.label, x: entry.x, y: entry.y };
      }),
    };
  }
  el = listed.length === 1 ? listed[0] : matches[0] || null;
  if (!el) return { ok: false, reason: "none" };
}
`

/** What an act script answers: acted, no fit, or the fit is unclear. */
export interface PageActAnswer {
  ok: boolean
  reason?: "none" | "many"
  total?: number
  candidates?: { index: number; role: string; label: string; x: number; y: number }[]
}

/**
 * A script that clicks the control that the target names, or types into it. A plain number
 * picks from the listing; anything else is a CSS selector. A selector that fits more than one
 * listed control acts on nothing and answers with up to 5 candidates instead. A fit outside
 * the listing (a hidden control) keeps the old behaviour: the first fit acts.
 */
export const pageActScript = (
  kind: "click" | "type",
  target: string,
  text = "",
): string => `(() => {
${CONTROLS_CORE}
${TRAP_ERRORS}
const target = ${JSON.stringify(target)};
const list = listOf();
${FIND_TARGET}
${
  kind === "click"
    ? "el.click();"
    : `el.focus();
if ("value" in el) el.value = ${JSON.stringify(text)};
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));`
}
return { ok: true };
})()`

/** What the read script answers: the text, the shown controls and the count of all controls. */
export interface PageReadAnswer {
  text: string
  controls: { index: number; role: string; label: string }[]
  total: number
}

/**
 * A script that reads the page in one run: its text and its controls. The first rows go to the
 * read list; the count says how many the cap hides.
 */
export const pageReadScript = (textMax: number): string => `(() => {
${CONTROLS_CORE}
const text = document.body ? document.body.innerText : "";
const all = document.querySelectorAll(${JSON.stringify(CONTROLS_QUERY)});
const shown = [];
let total = 0;
for (const el of all) {
  if (el.disabled || !visibleOf(el)) continue;
  total += 1;
  if (shown.length >= ${PAGE_CONTROLS_MAX}) continue;
  shown.push({ index: total, role: roleOf(el), label: labelOf(el) });
}
return { text: String(text).slice(0, ${textMax}), controls: shown, total };
})()`

/** What the state script answers: the focused control and the errors since the last action. */
export interface PageStateAnswer {
  focus: string | null
  errors: string[]
}

/** A script that reads which control has the focus and drains the errors of the page. */
export const pageStateScript = (): string => `(() => {
${CONTROLS_CORE}
const errors = window.__robotErrors || [];
window.__robotErrors = [];
const active = document.activeElement;
const focus =
  active && active !== document.body && active !== document.documentElement
    ? roleOf(active) + ' "' + labelOf(active) + '"'
    : null;
return { focus, errors: errors.slice(0, 5) };
})()`

/** What the inspect script answers: the facts of one control, or no fit, or an unclear fit. */
export interface PageInspectAnswer {
  ok: boolean
  reason?: "none" | "many"
  total?: number
  candidates?: { index: number; role: string; label: string; x: number; y: number }[]
  facts?: { role: string; label: string; submit: boolean; method: string; secure: boolean }
  formHost?: string | null
}

/**
 * A script that finds the control a target names, with the same fit rules as `pageActScript`, and
 * answers what a click on it would be (spec 007): does it submit a form, with which method and to
 * which host, and is it a password, a code or a card field. It acts on nothing.
 */
export const pageInspectScript = (target: string): string => `(() => {
${CONTROLS_CORE}
const target = ${JSON.stringify(target)};
const list = listOf();
${FIND_TARGET}
const form = el.form || (el.closest ? el.closest("form") : null);
const kind = (el.type || "").toLowerCase();
const submit =
  !!form &&
  ((el.tagName === "BUTTON" && (kind === "" || kind === "submit")) ||
    (el.tagName === "INPUT" && (kind === "submit" || kind === "image")));
let formHost = null;
if (form) {
  try {
    formHost = new URL(form.getAttribute("action") || location.href, location.href).host;
  } catch (bad) {
    formHost = null;
  }
}
return {
  ok: true,
  facts: {
    role: roleOf(el),
    label: labelOf(el),
    submit,
    method: form ? String(form.getAttribute("method") || "get").toLowerCase() : "get",
    secure: isSecure(el),
  },
  formHost,
};
})()`

/**
 * A script that chooses an option of a list. The option is found by its value, then by its text.
 * It answers with the same shape as an act script.
 */
export const pageSelectScript = (target: string, value: string): string => `(() => {
${CONTROLS_CORE}
${TRAP_ERRORS}
const target = ${JSON.stringify(target)};
const want = ${JSON.stringify(value)};
const list = listOf();
${FIND_TARGET}
if (el.tagName !== "SELECT") return { ok: false, reason: "none" };
const options = Array.from(el.options);
const hit =
  options.find((o) => o.value === want) ||
  options.find((o) => o.text.trim() === want.trim()) ||
  options.find((o) => o.text.trim().toLowerCase() === want.trim().toLowerCase());
if (!hit) return { ok: false, reason: "none" };
el.value = hit.value;
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
return { ok: true };
})()`

/** A script that says if the document shows a password, a code or a card field. */
export const pageSecureScript = (): string => `(() => {
${CONTROLS_CORE}
for (const el of document.querySelectorAll("input")) {
  if (isSecure(el) && visibleOf(el)) return true;
}
return false;
})()`
