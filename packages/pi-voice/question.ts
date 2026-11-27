/**
 * The voice question protocol: one extension asks a question, the voice channel
 * asks the user out loud, and the spoken answer comes back as data.
 *
 * Pi extensions cannot call each other and cannot see each other's tools, so the
 * contract is carried on `pi.events` (a `EventBus` shared by every extension in the
 * process). Anything that blocks a Pi turn on a human — a questionnaire, a
 * confirmation, a "which file did you mean?" — can offer itself to voice with four
 * channels and no dependency on this package:
 *
 *   provider  ->  voice:question            { id, toolCallId?, title?, questions[] }
 *   voice     ->  voice:question:accepted   { id, spoken }
 *   provider  ->  voice:question:withdraw   { id }                      (answered on screen)
 *   voice     ->  voice:answer              { id, answers[], cancelled } (spoken answer)
 *
 * The provider never blocks on voice: it shows its own UI and resolves it either
 * from the keyboard or from a `voice:answer`. If nothing is listening (voice off),
 * nothing happens and the keyboard still works. See README "Answering Pi's questions
 * by voice" for the ten-line provider snippet.
 */

import { redactSecrets } from "./util.ts";

export const VOICE_QUESTION_CHANNEL = "voice:question";
export const VOICE_QUESTION_ACCEPTED_CHANNEL = "voice:question:accepted";
export const VOICE_QUESTION_WITHDRAW_CHANNEL = "voice:question:withdraw";
export const VOICE_ANSWER_CHANNEL = "voice:answer";

/** How long a spoken prompt stays answerable. */
export const QUESTION_TTL_MS = 5 * 60_000;

export interface VoiceQuestionOption {
    /** Returned to the provider when chosen. */
    value: string;
    /** What the user hears. */
    label: string;
    description?: string;
}

export interface VoiceQuestionItem {
    /** Stable id, echoed back in the answer. */
    id: string;
    prompt: string;
    /** Short label for the question (a tab title, a field name). */
    label?: string;
    /** Choices. Omitted means free-form. */
    options?: VoiceQuestionOption[];
    /** Whether a spoken free-text answer is acceptable (default true). */
    allowOther?: boolean;
}

export interface VoiceQuestionRequest {
    /** Unique per prompt; the answer is matched on this. */
    id: string;
    /** The tool call waiting for the answer, when there is one. */
    toolCallId?: string;
    title?: string;
    questions: VoiceQuestionItem[];
}

export interface VoiceAnswerItem {
    questionId: string;
    /** Set when the utterance matched one of the offered options. */
    option?: VoiceQuestionOption;
    /** Free text, when the user answered in their own words (or nothing matched). */
    text?: string;
    /** What the user actually said, verbatim. */
    said: string;
}

export interface VoiceAnswerResult {
    id: string;
    answers: VoiceAnswerItem[];
    cancelled: boolean;
    /**
     * Why the prompt closed. `cancelled` alone could not tell "the user said handle
     * it yourself" apart from "voice stopped" or "the prompt expired", so a provider
     * waiting without a UI had no way to fall back to the keyboard immediately.
     */
    reason?: "cancelled" | "expired" | "voice-stopped" | "reload";
}

/** A question could not be parsed out of an event payload. */
function text(value: unknown, max = 400): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();

    return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * An identity field (request id, question id, option value) that has to survive parsing
 * unchanged.
 *
 * The provider matches a spoken answer against the value it sent. Silently trimming or
 * truncating it meant pi-voice reported a question answered while the provider dropped
 * the answer it no longer recognised (and a headless provider waited out its timeout).
 * No field is derived or rewritten: a request id or question id that is present but
 * unusable rejects the request, and an option value must be sent as it should come back.
 * (A question with no id at all gets a positional `q1`, `q2`, ... — a convention for
 * providers that answer by position, not a rewrite of an id the provider supplied.)
 */
function identity(value: unknown, max = 120): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const canonical = text(value, max);

    return canonical !== undefined && canonical === value ? canonical : undefined;
}

function parseOptions(value: unknown): VoiceQuestionOption[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        throw new Error("options must be an array");
    }

    // Rejecting the whole request is deliberate: silently keeping eleven of twelve
    // options would let the model answer a prompt the provider no longer recognises.
    if (value.length > 12) {
        throw new Error(`too many options (${value.length} > 12)`);
    }

    const options: VoiceQuestionOption[] = [];

    for (const entry of value) {
        if (typeof entry === "string") {
            // The string *is* the option value, so it is an identity: a padded or over-long
            // one cannot be silently trimmed into a value the provider does not recognise.
            const optionValue = identity(entry, 120);

            if (!optionValue) {
                throw new Error("an option string must be a non-empty, already-trimmed string of at most 120 characters");
            }

            options.push({ value: optionValue, label: optionValue });

            continue;
        }

        if (!entry || typeof entry !== "object") {
            throw new Error("option must be a string or an object");
        }

        const record = entry as Record<string, unknown>;

        // A value is required and never derived from the label: the label is display text
        // that pi-voice may shorten, and a value invented from it is one the provider's
        // own option (which had no value) can never match.
        const optionValue = identity(record.value, 120);

        if (!optionValue) {
            throw new Error("an option needs a value: a non-empty, already-trimmed string of at most 120 characters");
        }

        const label = text(record.label, 120) ?? optionValue;

        if (!label) {
            throw new Error("option needs a label or a value");
        }

        const description = text(record.description, 200);

        options.push({
            value: optionValue,
            label,
            ...(description ? { description } : {}),
        });
    }

    return options.length > 0 ? options : undefined;
}

/**
 * Validate a payload from another extension.
 *
 * Everything on the bus is untrusted: a malformed request is rejected as a whole,
 * never half-applied. Dropping one bad question out of seven used to leave the
 * provider waiting on a prompt voice believed it had fully answered.
 */
export function parseQuestionRequest(value: unknown): VoiceQuestionRequest | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const id = identity(record.id, 120);

    if (!id || !Array.isArray(record.questions)) {
        return undefined;
    }

    if (record.questions.length === 0 || record.questions.length > 6) {
        return undefined;
    }

    const questions: VoiceQuestionItem[] = [];
    const seen = new Set<string>();

    for (const entry of record.questions) {
        if (!entry || typeof entry !== "object") {
            return undefined;
        }

        const question = entry as Record<string, unknown>;
        const prompt = text(question.prompt, 400) ?? text(question.question, 400);
        const namedId = question.id === undefined || question.id === null ? undefined : identity(question.id, 120);
        const questionId = namedId ?? (question.id === undefined || question.id === null ? `q${questions.length + 1}` : undefined);

        if (!prompt || !questionId || seen.has(questionId)) {
            return undefined;
        }

        seen.add(questionId);

        let options: VoiceQuestionOption[] | undefined;

        try {
            options = parseOptions(question.options);
        } catch {
            return undefined;
        }

        // Choices-only with nothing to choose cannot be answered at all: it used to be
        // accepted and spoken while every answer was rejected, so a provider without a
        // UI waited out its timeout for a question that had no valid answer.
        if (question.allowOther === false && !options) {
            return undefined;
        }

        questions.push({
            id: questionId,
            prompt,
            ...(text(question.label, 80) ? { label: text(question.label, 80) as string } : {}),
            ...(options ? { options } : {}),
            allowOther: question.allowOther !== false,
        });
    }

    return {
        id,
        ...(text(record.toolCallId, 120) ? { toolCallId: text(record.toolCallId, 120) as string } : {}),
        ...(text(record.title, 120) ? { title: text(record.title, 120) as string } : {}),
        questions,
    };
}

/**
 * Fold to lowercase and keep letters/digits from any script, so a Chinese, Greek or
 * accented option is still matchable. Punctuation and spacing become single spaces.
 */
function normalize(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Is `candidate` mentioned in `said`, as a *word*?
 *
 * Matching is token-based, not substring-based: the old `includes` check let the
 * option "cat" match "please concatenate the file", silently picking a choice the user
 * never made. Both directions count, so a truncated utterance still lands ("postgres"
 * against the label "postgres please").
 */
function contains(said: string, candidate: string): boolean {
    const saidTokens = said.split(" ").filter(Boolean);
    const candidateTokens = candidate.split(" ").filter(Boolean);

    // Single-character words ("a", "y") are articles or fragments in almost any
    // sentence; they only match when they are the whole answer, which the exact pass
    // has already checked by the time we get here.
    if (candidateTokens.length === 0 || !candidateTokens.every((token) => token.length >= 2)) {
        return false;
    }

    const covered = (needle: string[], haystack: string[]): boolean =>
        needle.every((token) => haystack.includes(token));

    return covered(candidateTokens, saidTokens) || (saidTokens.length > 0 && covered(saidTokens, candidateTokens));
}

/** Same option offered twice (identical value and label) is not an ambiguity. */
function distinct(options: VoiceQuestionOption[]): VoiceQuestionOption[] {
    const seen = new Set<string>();

    return options.filter((option) => {
        const key = `${option.value}\u0000${option.label}`;

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);

        return true;
    });
}

const WORD_NUMBERS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
    ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

const CHOICE_FILLER = new Set(["option", "number", "choice", "the", "and"]);

/**
 * A spoken choice by number: "2", "option 2", "the second", "the second one", "number
 * two", "the second choice". People do not read option ids out loud, so this carries
 * most of the load.
 */
function choiceIndex(said: string): number | undefined {
    const tokens = said.split(" ").filter(Boolean).filter((word) => !CHOICE_FILLER.has(word));
    // "the second one", "number one": a trailing "one" is a determiner after another
    // number, but on its own it *is* the number. Stripping it unconditionally made
    // "one" unanswerable without an option literally called "one".
    const words = tokens.length === 2 && tokens[1] === "one" && WORD_NUMBERS[tokens[0]] !== undefined
        ? [tokens[0]]
        : tokens;

    if (words.length !== 1) {
        return undefined;
    }

    const [word] = words;

    return /^\d{1,2}$/.test(word) ? Number(word) : WORD_NUMBERS[word];
}

/** Affirmative/negative forms people actually say, mapped to the labels they mean. */
const AFFIRMATIVE_WORDS = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "correct", "confirm", "affirmative", "absolutely", "go ahead", "do it", "proceed", "continue"];
const NEGATIVE_WORDS = ["no", "nope", "nah", "negative", "deny", "cancel", "reject", "stop", "abort", "skip", "dont", "don t", "do not", "never"];
const YES_LABELS = new Set(["yes", "y", "true", "ok", "okay", "confirm", "allow", "approve", "accept", "continue", "proceed", "go", "agree", "enable"]);
const NO_LABELS = new Set(["no", "n", "false", "cancel", "deny", "reject", "stop", "abort", "skip", "disallow", "disable", "never", "nope"]);

/** "yeah" against an option called "Yes", "no thanks" against "No". */
function matchSynonym(said: string, options: VoiceQuestionOption[]): VoiceQuestionOption | undefined {
    const words = new Set(said.split(" ").filter(Boolean));
    // Whole words only: `said.includes("ok")` is true for "joke" and `includes("no")`
    // for "nope"... which is why multi-word phrases get their own branch.
    const mentions = (list: string[]): boolean =>
        list.some((word) => (word.includes(" ") ? said.includes(word) : words.has(word)));
    const saysYes = mentions(AFFIRMATIVE_WORDS);
    const saysNo = mentions(NEGATIVE_WORDS);
    const pick = (labels: Set<string>): VoiceQuestionOption | undefined => {
        const hits = distinct(options.filter((option) => labels.has(normalize(option.value)) || labels.has(normalize(option.label))));

        return hits.length === 1 ? hits[0] : undefined;
    };

    if (saysYes) {
        return pick(YES_LABELS);
    }

    return saysNo ? pick(NO_LABELS) : undefined;
}

/**
 * Match what the user said against the offered options.
 *
 * The voice model is told to send the option's `value`, but a spoken answer arrives
 * as whatever the model transcribed: "2", "the second one", "use postgres", "Postgres
 * please". Exact id, label, 1-based index, a single unambiguous mention and the common
 * yes/no forms all count; anything ambiguous is left to free text rather than guessing.
 */
export function matchOption(utterance: string, options: VoiceQuestionOption[]): VoiceQuestionOption | undefined {
    const said = normalize(utterance);

    if (!said || options.length === 0) {
        return undefined;
    }

    const exact = distinct(options.filter(
        (option) => normalize(option.value) === said || normalize(option.label) === said,
    ));

    if (exact.length > 0) {
        // Two options carrying the same wording is ambiguous: refusing to guess is the
        // only safe answer ("delete" against two "Delete" options).
        return exact.length === 1 ? exact[0] : undefined;
    }

    const index = choiceIndex(said);

    if (index !== undefined) {
        return options[index - 1];
    }

    // One option mentioned by name: "use postgres", "postgres please".
    const mentioned = distinct(options.filter((option) =>
        contains(said, normalize(option.value)) || contains(said, normalize(option.label)),
    ));

    if (mentioned.length === 1) {
        return mentioned[0];
    }

    if (mentioned.length === 0) {
        return matchSynonym(said, options);
    }

    return undefined;
}

/**
 * Turn the model's `voice_answer` arguments into answers for the provider.
 *
 * Every question gets at most one answer; the provider receives the matched option
 * when there is one, so it never has to re-implement matching (and never receives an
 * option it did not offer).
 */
export function resolveAnswers(
    questions: VoiceQuestionItem[],
    raw: unknown,
): { answers: VoiceAnswerItem[]; unknown: string[] } {
    const list = Array.isArray(raw) ? raw : [];
    const answers: VoiceAnswerItem[] = [];
    const unknown: string[] = [];
    const byId = new Map(questions.map((question) => [question.id, question]));
    const answered = new Set<string>();

    for (const entry of list.slice(0, 6)) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const record = entry as Record<string, unknown>;
        const namedId = text(record.questionId, 120);
        const question = namedId
            ? byId.get(namedId)
            : questions.length === 1
                ? questions[0]
                : undefined;

        if (!question) {
            if (namedId) {
                unknown.push(namedId);
            }

            continue;
        }

        if (answered.has(question.id)) {
            continue;
        }

        const value = text(record.value, 500);
        const freeText = text(record.text, 500);
        const said = value ?? freeText ?? "";
        const options = question.options ?? [];
        const option = value ? matchOption(value, options) : freeText ? matchOption(freeText, options) : undefined;

        // An option's own wording is not a free-text answer; anything that matched an
        // option is reported as that option so the provider's keyboard path and the
        // spoken path produce the same value.
        if (option) {
            answered.add(question.id);
            answers.push({ questionId: question.id, option, said });

            continue;
        }

        if (question.allowOther === false) {
            // The question offered choices only. An unmatched utterance is not silently
            // turned into a free-text answer the provider would have to reject.
            if (said) {
                unknown.push(`${question.id}: ${said.slice(0, 80)}`);
            }

            continue;
        }

        if (freeText || value) {
            answered.add(question.id);
            answers.push({ questionId: question.id, text: freeText ?? value ?? "", said });
        }
    }

    return { answers, unknown };
}

/**
 * The option list as it is read to the model.
 *
 * An option whose *value* is credential-shaped is shown by number and label only: the
 * notice is transmitted and spoken, and the model can still answer by number (the
 * matcher resolves "2"/"the second one" to the option).
 */
function optionLine(options: VoiceQuestionOption[]): string {
    return options
        .map((option, index) => {
            const detail = option.description ? ` — ${option.description}` : "";
            const safeValue = redactSecrets(option.value);
            const shown = safeValue === option.value ? ` value=${JSON.stringify(option.value)}` : "";

            return `${index + 1})${shown} ${option.label}${detail}`;
        })
        .join("; ");
}

/**
 * The note handed to the voice model when Pi is waiting for an answer.
 *
 * It carries the ids and the exact argument shape, because the model has to answer
 * with a tool call, and it says what to do when the user answers in their own words
 * (`text`) instead of naming an option.
 *
 * Everything spoken is redacted first: an option value or prompt can be a command line
 * or a header, and this text is transmitted to Gemini and read out loud.
 */
export function questionNotice(request: VoiceQuestionRequest): string {
    const lines = [
        `[Pi is waiting for the user's answer] id=${request.id}`
            + (request.title ? ` (${request.title})` : ""),
    ];
    let anyFreeText = false;

    for (const question of request.questions) {
        const options = question.options ?? [];
        const label = question.label ? `[${question.label}] ` : "";

        lines.push(`- questionId=${question.id}: ${label}${question.prompt}`);

        if (options.length > 0) {
            lines.push(`  options: ${optionLine(options)}`);
            lines.push(`  ${question.allowOther === false ? "no free text" : "free text is also allowed"}`);
        } else {
            lines.push("  no fixed options: answer with text");
        }

        anyFreeText = anyFreeText || question.allowOther !== false;
    }

    const example = request.questions[0];
    const sample = example?.options?.[0];
    // With no options the example must use `text`: a model copying the literal
    // placeholder `"<option value>"` recorded it as the user's answer. A redacted
    // value is replaced by its number for the same reason.
    const sampleValue = !sample
        ? undefined
        : redactSecrets(sample.value) === sample.value
            ? sample.value
            : "1";
    const exampleArg = sampleValue !== undefined
        ? `"value": ${JSON.stringify(sampleValue)}`
        : "\"text\": \"<the user's own words>\"";

    lines.push(
        "",
        `Ask the user in one short question, reading the choices briefly. Then call voice_answer with`
            + ` {"id": ${JSON.stringify(request.id)}, "answers": [{"questionId": ${JSON.stringify(example?.id ?? "q1")},`
            + ` ${exampleArg}}]}`
            + (anyFreeText
                ? ` — use "text" instead of "value" when the user answers in their own words,`
                : " — a question with no free text accepts only one of the listed option values,")
            + ` and "cancel": true if they would rather answer on screen.`,
        request.questions.length > 1
            ? `Every question needs an answer: ${request.questions.map((question) => question.id).join(", ")}.`
            : "Do not repeat the question once the user has answered.",
    );

    return redactSecrets(lines.join("\n"));
}

/** The note that retires a prompt (answered on screen, or expired). */
export function questionWithdrawnNotice(id: string): string {
    return redactSecrets(`[Answer no longer needed] id=${id}: the user already answered on screen. Drop that question; do not ask it again.`);
}

/**
 * Read-only announcement for a tool that is waiting for input but never offered
 * itself to voice (a questionnaire written before this protocol existed).
 *
 * Voice cannot answer it, so the note must not imply it can: it only tells the user
 * where the question is.
 */
export function waitingForInputNotice(toolName: string, prompts: string[]): string {
    const lines = [
        `[Pi is blocked waiting for the user to answer on screen] tool=${toolName}`,
        ...prompts.slice(0, 4).map((prompt) => `- ${prompt.slice(0, 240)}`),
        "",
        "Tell the user in one short sentence that Pi is waiting for an answer in the editor, and read the"
            + " question so they know what it is. You cannot pass an answer back for this one; do not ask them"
            + " to tell you — they must answer with the keyboard.",
    ];

    return redactSecrets(lines.join("\n"));
}

/**
 * Best-effort recognition of "this tool call is a questionnaire" from its arguments.
 *
 * Used only for the read-only announcement, so it stays conservative: an array of
 * objects each carrying a prompt-ish string. A tool that adopts the protocol is
 * recognised by its own request instead, which is why pi-voice suppresses this when a
 * registered question covers the same tool call.
 */
export function questionsFromArgs(args: unknown): string[] | undefined {
    if (!args || typeof args !== "object") {
        return undefined;
    }

    const record = args as Record<string, unknown>;
    const list = record.questions ?? record.questions_and_answers;

    if (!Array.isArray(list) || list.length === 0) {
        return undefined;
    }

    const prompts: string[] = [];

    for (const entry of list.slice(0, 4)) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const question = entry as Record<string, unknown>;
        const prompt = text(question.prompt, 240) ?? text(question.question, 240);

        if (!prompt) {
            continue;
        }

        // Best effort: a read-only announcement must never throw. An option the parser
        // rejects (a label-only object, a padded string) is simply not announced.
        let labels: string[] = [];

        try {
            labels = (parseOptions(question.options) ?? []).map((option) => option.label);
        } catch {
            labels = [];
        }

        const options = labels.length > 0 ? ` (options: ${labels.join(", ")})` : "";

        prompts.push(`${prompt}${options}`);
    }

    return prompts.length > 0 ? prompts : undefined;
}