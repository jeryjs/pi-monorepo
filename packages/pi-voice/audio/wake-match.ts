/**
 * Wake-phrase matching for the ASR engine.
 *
 * A keyword spotter compares acoustics to one tokenised phrase; an ASR decodes
 * words, and "hey pi" comes back as "HAY PE", "HEY P", "HEYPI", "HAYPE" or
 * "Y PIKE". Matching has to tolerate that without firing on ordinary speech
 * ("hey bud", "the pie is ready", "a pie").
 *
 * Rules: one edit per word of three or more letters, none for short words, and a
 * length-guarded joined form for words the decoder runs together. The joined form
 * spends its one allowed edit per half rather than two across the whole string,
 * which is the difference between "HAYPE" (a real way "hey pi" comes back) and
 * "HEYNO" (ordinary speech).
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

        // 2) joined: "HEYPI", "HAYPE", "HAY PE" -> "HAYPE".
        //
        // Budgeting two edits across the whole string made the short word free:
        // "HEYNO" and "HEY PO" are both within two edits of "HEYPI", so "hey no"
        // opened a session. Split the candidate into the same halves as the phrase
        // and allow one edit in each: "HAY"+"PE" (1+1) still matches, "HEY"+"NO"
        // (0+2) does not. For phrases longer than two words keep the strict budget.
        const joined = target.join("");
        const head = target.slice(0, -1).join("");
        const tail = target[target.length - 1] as string;

        // Trade-off, deliberate: one edit in the short word still matches ("HEY PO"
        // is one edit from HEYPI). Only a phonetic model could tell that apart from
        // "HAY PE", which is a real way the decoder splits "hey pi". The strict rule
        // (zero edits for short words) is the token path above.

        for (let i = 0; i < words.length; i++) {
            for (let span = 1; span <= 2 && i + span <= words.length; span++) {
                const candidate = words.slice(i, i + span).join("");

                if (candidate.length < joined.length - 1 || candidate.length > joined.length + 1) {
                    continue;
                }

                if (target.length === 2) {
                    // The edit may fall on either side of the split ("HEYP" dropped a
                    // letter from the head), so try the three plausible split points
                    // instead of assuming the tail always starts at len - tail.length.
                    const from = Math.max(0, head.length - 1);
                    const to = Math.min(candidate.length, head.length + 1);
                    let best = Number.POSITIVE_INFINITY;
                    let split = -1;

                    for (let headLength = from; headLength <= to; headLength++) {
                        const headDistance = editDistance(candidate.slice(0, headLength), head);
                        const tailDistance = editDistance(candidate.slice(headLength), tail);

                        if (headDistance <= 1 && tailDistance <= 1 && headDistance + tailDistance < best) {
                            best = headDistance + tailDistance;
                            split = headLength;
                        }
                    }

                    if (split >= 0) {
                        return { matched: true, phrase, heard: candidate, distance: best };
                    }

                    continue;
                }

                const distance = editDistance(candidate, joined);

                if (distance <= 1) {
                    return { matched: true, phrase, heard: candidate, distance };
                }
            }
        }
    }

    return { matched: false };
}