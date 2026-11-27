/**
 * Wake-phrase matching for the ASR engine.
 *
 * A keyword spotter compares acoustics to one tokenised phrase; an ASR decodes
 * words, and "hey pi" comes back as "HAY PE", "HEY P", "HEYPI", "HAYPE" or
 * "Y PIKE". Matching has to tolerate that without firing on ordinary speech
 * ("hey bud", "the pie is ready", "a pie").
 *
 * Rules: one edit per word of three or more letters, none for short words, and a
 * length-guarded joined form for words the decoder runs together.
 */

export interface WakeMatch {
    matched: boolean;
    /** The configured phrase that matched. */
    phrase?: string;
    /** What the decoder actually heard in that window. */
    heard?: string;
    /** Edit distance for the joined form (0 for an exact token match). */
    distance?: number;
}

function normalize(text: string): string[] {
    return text
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

/** Levenshtein distance, small strings only. */
export function editDistance(a: string, b: string): number {
    if (a === b) {
        return 0;
    }

    const cols = b.length + 1;
    let previous = new Int32Array(cols);

    for (let j = 0; j < cols; j++) {
        previous[j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
        const current = new Int32Array(cols);

        current[0] = i;

        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;

            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
        }

        previous = current;
    }

    return previous[cols - 1];
}

/**
 * Does this transcript contain the wake phrase?
 *
 * `phrases` are the user's wake phrases ("hey pi", "hi pi"). The ASR decodes
 * continuously, so the caller passes the text heard so far.
 */
export function matchWakePhrase(text: string, phrases: readonly string[]): WakeMatch {
    const words = normalize(text);

    if (words.length === 0) {
        return { matched: false };
    }

    for (const phrase of phrases) {
        const target = normalize(phrase);

        if (target.length === 0) {
            continue;
        }

        // 1) token by token: one edit for words of 3+ letters ("HEY" -> "HAY"),
        //    none for short ones ("PI" must be a PI).
        for (let start = 0; start + target.length <= words.length; start++) {
            const hit = target.every((want, k) => editDistance(words[start + k], want) <= (want.length >= 3 ? 1 : 0));

            if (hit) {
                return {
                    matched: true,
                    phrase,
                    heard: words.slice(start, start + target.length).join(" "),
                    distance: 0,
                };
            }
        }

        // 2) joined: "HEYPI", "HAYPE", "HAY PE" -> "HAYPE". The length guard is what
        //    keeps "HEY" alone (from "hey bud") from matching a 5-letter phrase.
        const joined = target.join("");

        for (let i = 0; i < words.length; i++) {
            for (let span = 1; span <= 2 && i + span <= words.length; span++) {
                const candidate = words.slice(i, i + span).join("");

                if (candidate.length < joined.length - 1 || candidate.length > joined.length + 1) {
                    continue;
                }

                const distance = editDistance(candidate, joined);

                if (distance <= 2) {
                    return { matched: true, phrase, heard: candidate, distance };
                }
            }
        }
    }

    return { matched: false };
}