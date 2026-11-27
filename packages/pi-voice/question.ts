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
}

/** A question could not be parsed out of an event payload. */
function text(value: unknown, max = 400): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();

    return trimmed ? trimmed.slice(0, max) : undefined;
}

function parseOptions(value: unknown): VoiceQuestionOption[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const options: VoiceQuestionOption[] = [];

    for (const entry of value.slice(0, 12)) {
        if (typeof entry === "string") {
            const label = text(entry, 120);

            if (label) {
                options.push({ value: label, label });
            }

            continue;
        }

        if (!entry || typeof entry !== "object") {
            continue;
        }

        const record = entry as Record<string, unknown>;
        const label = text(record.label, 120) ?? text(record.value, 120);
        const optionValue = text(record.value, 120) ?? label;

        if (!label || !optionValue) {
            continue;
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
 * Everything on the bus is untrusted: a malformed request must be ignored, never
 * half-applied, and text that will be spoken is capped so one request cannot
 * monopolise the model's turn.
 */
export function parseQuestionRequest(value: unknown): VoiceQuestionRequest | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const id = text(record.id, 120);

    if (!id || !Array.isArray(record.questions)) {
        return undefined;
    }

    const questions: VoiceQuestionItem[] = [];

    for (const entry of record.questions.slice(0, 6)) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const question = entry as Record<string, unknown>;
        const prompt = text(question.prompt, 400) ?? text(question.question, 400);
        const questionId = text(question.id, 120) ?? `q${questions.length + 1}`;

        if (!prompt) {
            continue;
        }

        const options = parseOptions(question.options);

        questions.push({
            id: questionId,
            prompt,
            ...(text(question.label, 80) ? { label: text(question.label, 80) as string } : {}),
            ...(options ? { options } : {}),
            allowOther: question.allowOther !== false,
        });
    }

    if (questions.length === 0) {
        return undefined;
    }

    return {
        id,
        ...(text(record.toolCallId, 120) ? { toolCallId: text(record.toolCallId, 120) as string } : {}),
        ...(text(record.title, 120) ? { title: text(record.title, 120) as string } : {}),
        questions,
    };
}

function normalize(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Is `candidate` mentioned in `said`, as a word worth matching? */
function contains(said: string, candidate: string): boolean {
    if (candidate.length < 3) {
        return false;
    }

    return said.includes(candidate) || (said.length >= 3 && candidate.includes(said));
}

const WORD_NUMBERS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
    ninth: 9, tenth: 10,
};

/**
 * A spoken choice by number: "2", "option 2", "the second", "the second one", "number
 * two". People do not read option ids out loud, so this carries most of the load.
 */
function choiceIndex(said: string): number | undefined {
    const trimmed = said
        .replace(/^(?:option|number|choice|the)\s+/, "")
        .replace(/\s+one$/, "")
        .trim();

    if (/^\d{1,2}$/.test(trimmed)) {
        return Number(trimmed);
    }

    return WORD_NUMBERS[trimmed];
}

/**
 * Match what the user said against the offered options.
 *
 * The voice model is told to send the option's `value`, but a spoken answer arrives
 * as whatever the model transcribed: "2", "the second one", "use postgres", "Postgres
 * please". Exact id, label, 1-based index and a single unambiguous containment all
 * count; anything ambiguous is left to free text rather than guessing.
 */
export function matchOption(utterance: string, options: VoiceQuestionOption[]): VoiceQuestionOption | undefined {
    const said = normalize(utterance);

    if (!said) {
        return undefined;
    }

    for (const option of options) {
        if (normalize(option.value) === said || normalize(option.label) === said) {
            return option;
        }
    }

    const index = choiceIndex(said);

    if (index !== undefined) {
        return options[index - 1];
    }

    // One option mentioned by name: "use postgres", "postgres please". Containment only
    // for words long enough to mean something: a one-letter option value ("a", "y")
    // is a substring of almost every sentence and matched everything.
    const hits = options.filter((option) => {
        const value = normalize(option.value);
        const label = normalize(option.label);

        return contains(said, value) || contains(said, label);
    });

    return hits.length === 1 ? hits[0] : undefined;
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

function optionLine(options: VoiceQuestionOption[]): string {
    return options
        .map((option, index) => {
            const detail = option.description ? ` — ${option.description}` : "";

            return `${index + 1}) value=${JSON.stringify(option.value)} ${option.label}${detail}`;
        })
        .join("; ");
}

/**
 * The note handed to the voice model when Pi is waiting for an answer.
 *
 * It carries the ids and the exact argument shape, because the model has to answer
 * with a tool call, and it says what to do when the user answers in their own words
 * (`text`) instead of naming an option.
 */
export function questionNotice(request: VoiceQuestionRequest): string {
    const lines = [
        `[Pi is waiting for the user's answer] id=${request.id}`
            + (request.title ? ` (${request.title})` : ""),
    ];

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
    }

    const example = request.questions[0];
    const sample = example?.options?.[0];

    lines.push(
        "",
        `Ask the user in one short question, reading the choices briefly. Then call voice_answer with`
            + ` {"id": ${JSON.stringify(request.id)}, "answers": [{"questionId": ${JSON.stringify(example?.id ?? "q1")},`
            + ` "value": ${JSON.stringify(sample?.value ?? "<option value>")}}]}`
            + ` — use "text" instead of "value" when the user answers in their own words,`
            + ` and "cancel": true if they would rather answer on screen.`,
        request.questions.length > 1
            ? `Every question needs an answer: ${request.questions.map((question) => question.id).join(", ")}.`
            : "Do not repeat the question once the user has answered.",
    );

    return lines.join("\n");
}

/** The note that retires a prompt (answered on screen, or expired). */
export function questionWithdrawnNotice(id: string): string {
    return `[Answer no longer needed] id=${id}: the user already answered on screen. Drop that question; do not ask it again.`;
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

    return lines.join("\n");
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

        const labels = (parseOptions(question.options) ?? []).map((option) => option.label);
        const options = labels.length > 0 ? ` (options: ${labels.join(", ")})` : "";

        prompts.push(`${prompt}${options}`);
    }

    return prompts.length > 0 ? prompts : undefined;
}