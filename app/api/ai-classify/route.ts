import {NextResponse} from "next/server";
// try to import official Google GenAI library if available without making bundlers resolve it at build time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let GoogleGenAI: any = null;
try {
    // Use eval("require") to prevent bundlers from statically resolving the dependency when it's optional
    GoogleGenAI = eval("require")("@google/genai").GoogleGenAI;
} catch {
    GoogleGenAI = null;
}

type Avg = { r: number; g: number; b: number };

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const avg: Avg = body.avg;
        const hex: string = body.hex;
        let faceImage: string | undefined = body.faceImage; // optional data URL (cropped face)
        // Safety: if client accidentally sends a very large image, drop it to avoid payload issues
        try {
            if (faceImage && typeof faceImage === "string") {
                console.log("[ai-classify] received faceImage length:", faceImage.length);
                if (faceImage.length > 48000) {
                    console.warn("[ai-classify] faceImage too large - ignoring image to avoid large requests");
                    faceImage = undefined;
                }
            }
        } catch {
            // ignore logging errors
        }

        // If user configured an external AI API, proxy the request.
        const AI_URL = process.env.AI_API_URL;
        const AI_KEY = process.env.AI_API_KEY;

        // Gemini (Google Generative Language) support
        const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GENAI_API_KEY;
        const GEMINI_MODEL = process.env.GEMINI_MODEL; // e.g. "gemini-1.5-mini" or "gemini-3.5-flash"
        const GEMINI_PROJECT = process.env.GEMINI_PROJECT; // optional, e.g. Google Cloud project id
        const USE_GENAI_LIB = GoogleGenAI && Boolean(GEMINI_KEY);

        // If Gemini is configured, call it to get a JSON response describing tone and palette.
        if (GEMINI_KEY && GEMINI_MODEL) {
            // build candidate model resource names to try (common formats)
            const candidates: string[] = [];
            if (GEMINI_MODEL.startsWith("projects/") || GEMINI_MODEL.startsWith("models/")) {
                candidates.push(GEMINI_MODEL);
            } else {
                candidates.push(`models/${GEMINI_MODEL}`);
            }
            if (GEMINI_PROJECT && !GEMINI_MODEL.startsWith("projects/")) {
                candidates.push(`projects/${GEMINI_PROJECT}/locations/global/models/${GEMINI_MODEL}`);
            }

            // Prepare prompt
            // Request a strict JSON schema. The model MUST respond only with a single JSON object
            // that contains these keys (exact names):
            // - seasonalTone (string) e.g. "봄 웜톤" or "Winter Cool"
            // - tone (one of "Warm","Cool","Unknown")
            // - confidence (number 0-100)
            // - recommended (array of 4 hex color strings, e.g. ["#AABBCC","#112233",...])
            // - analysis (object) with keys: skinTone (string, "웜"/"쿨"/"Unknown"), eyeColor (string), skinColor (string)
            // Respond with JSON only, no surrounding explanation. If you are unable to determine a field, use null or sensible default.
            let promptBase = `You are an assistant that receives an average skin color as RGB and hex. Respond ONLY with a single JSON object (no surrounding text) with the EXACT keys:
"seasonalTone" (string),
"tone" (one of "Warm","Cool","Unknown"),
"confidence" (number 0-100),
"recommended" (array of 4 hex color strings),
"analysis" (object with keys: "skinTone" (Simple Color String), "eyeColor" (Simple Color String), "skinColor" (Simple Color String)).
\nInput:\nRGB: ${avg.r}, ${avg.g}, ${avg.b}\nHex: ${hex}`;
            if (faceImage) {
                promptBase += `\n\nAlso analyze the face image provided as a base64 data URL below. Use the visual/face information to determine undertone, approximate eye color, and recommend 4 hex colors suitable for the user's personal color (warm or cool). Return only the requested JSON.`;
                promptBase += `\n\nIMAGE:\n${faceImage}`;
            }

            for (const candidateModel of candidates) {
                try {
                    // Derive a simple model name for the genai library if needed
                    const modelName = candidateModel.includes("/") ? candidateModel.split("/").pop() : candidateModel;

                    if (USE_GENAI_LIB) {
                        try {
                            const client = new GoogleGenAI({apiKey: GEMINI_KEY});
                            if (process.env.NODE_ENV !== "production") console.log("[ai-classify] Using @google/genai for model:", modelName);
                            const genResp = await client.models.generateContent({
                                model: String(modelName),
                                contents: promptBase
                            });
                            // log truncated
                            if (process.env.NODE_ENV !== "production") {
                                try {
                                    console.log("[ai-classify] genai raw:", JSON.stringify(genResp).slice(0, 2000));
                                } catch {
                                }
                            }
                            // try to extract text from common locations (handle content.parts case)
                            let textOutput: string | null = null;
                            if (typeof genResp === "string") {
                                textOutput = genResp as string;
                            } else if (typeof genResp?.outputText === "string") {
                                textOutput = genResp.outputText;
                            } else if (genResp?.candidates && Array.isArray(genResp.candidates) && genResp.candidates[0]) {
                                const c0 = genResp.candidates[0];
                                // candidate.content can be string or object with parts
                                if (typeof c0.content === "string") {
                                    textOutput = c0.content;
                                } else if (c0.content?.parts && Array.isArray(c0.content.parts)) {
                                    textOutput = c0.content.parts.map((p: unknown) => {
                                        if (typeof p === "object" && p !== null && Object.prototype.hasOwnProperty.call(p, "text")) {
                                            // access dynamically
                                            const t = (p as { [k: string]: unknown })["text"];
                                            return typeof t === "string" ? t : "";
                                        }
                                        return "";
                                    }).join("");
                                } else if (typeof c0.content?.text === "string") {
                                    textOutput = c0.content.text;
                                }
                            }
                            if (!textOutput) textOutput = JSON.stringify(genResp);

                            if (textOutput) {
                                const jsonText = extractJsonFromText(String(textOutput));
                                if (jsonText) {
                                    try {
                                        const parsed = JSON.parse(jsonText);
                                        const normalized = normalizeToSchema(parsed, avg, hex, faceImage);
                                        if (normalized) return NextResponse.json(normalized);
                                    } catch (parseErr) {
                                        if (process.env.NODE_ENV !== "production") console.error('[ai-classify] failed to parse JSON from genai response', parseErr);
                                    }
                                }
                            }
                        } catch (err) {
                            if (process.env.NODE_ENV !== "production") console.error("[ai-classify] genai lib call failed", err);
                            // fallthrough to fetch-based attempt below
                        }
                    }

                    // fallback to HTTP-based call
                    const modelId = candidateModel.startsWith("models/") || candidateModel.startsWith("projects/") ? candidateModel : `models/${candidateModel}`;
                    const url = `https://generativelanguage.googleapis.com/v1beta2/${modelId}:generateText?key=${GEMINI_KEY}`;
                    if (process.env.NODE_ENV !== "production") {
                        try {
                            console.log("[ai-classify] Trying Gemini model via REST:", modelId);
                        } catch {
                        }
                    }
                    const resp = await fetch(url, {
                        method: "POST",
                        headers: {"content-type": "application/json"},
                        body: JSON.stringify({prompt: {text: promptBase}}),
                    });
                    if (!resp.ok) {
                        const errText = await resp.text();
                        if (process.env.NODE_ENV !== "production") console.error(`[ai-classify] Gemini HTTP ${resp.status} response for model ${modelId}:`, errText.slice(0, 2000));
                        continue;
                    }
                    const data = await resp.json();
                    let textOutput: string | null = null;
                    if (data?.candidates && Array.isArray(data.candidates) && data.candidates[0]?.content) {
                        textOutput = data.candidates[0].content;
                    } else if (data?.output && Array.isArray(data.output) && data.output[0]?.content) {
                        textOutput = data.output[0].content;
                    } else if (typeof data?.["content"] === "string") {
                        textOutput = data.content;
                    } else {
                        textOutput = JSON.stringify(data);
                    }
                    if (process.env.NODE_ENV !== "production") {
                        try {
                            console.log("[ai-classify] Gemini raw output:", String(textOutput).slice(0, 2000));
                        } catch {
                        }
                    }
                    const jsonText = extractJsonFromText(String(textOutput));
                    if (jsonText) {
                        const parsed = JSON.parse(jsonText);
                        const normalized = normalizeToSchema(parsed, avg, hex, faceImage);
                        if (normalized) {
                            if (process.env.NODE_ENV !== "production") {
                                try {
                                    console.log("[ai-classify] Gemini parsed JSON:", normalized);
                                } catch {
                                }
                            }
                            return NextResponse.json(normalized);
                        }
                    }
                } catch (e) {
                    console.error("Gemini request failed for candidate", candidateModel, e);
                }
            }
        }

        if (AI_URL) {
            try {
                const resp = await fetch(AI_URL, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        ...(AI_KEY ? {Authorization: `Bearer ${AI_KEY}`} : {}),
                    },
                    body: JSON.stringify({avg, hex}),
                });
                const data = await resp.json();
                try {
                    const normalized = normalizeToSchema(data, avg, hex, faceImage);
                    if (normalized) return NextResponse.json(normalized);
                } catch (e) {
                    console.error('[ai-classify] failed to normalize external AI response', e);
                }
                return NextResponse.json(data);
            } catch (e) {
                console.error("AI proxy failed", e);
            }
        }

        const undertone = classifyTone(avg);
        const recommended = generatePalette(hex, undertone);
        const accuracy = computeAccuracy(avg, undertone, Boolean(faceImage));
        const seasonInfo = deriveSeason(avg, undertone);
        const aiAnalysis = {
            skinUndertone: undertone,
            eyeColor: "Unknown",
            skinToneHex: hex || null,
        };

        const localParsed = {
            seasonalTone: seasonInfo.seasonLabelKR || seasonInfo.season,
            tone: undertone,
            confidence: accuracy,
            recommended,
            analysis: {
                skinTone: undertone === 'Warm' ? '웜' : undertone === 'Cool' ? '쿨' : 'Unknown',
                eyeColor: aiAnalysis.eyeColor,
                skinColorDescription: aiAnalysis.skinToneHex || '',
            },
        };
        return NextResponse.json(localParsed);
    } catch (err) {
        console.error(err);
        return NextResponse.json({tone: "Unknown", recommended: []});
    }
}

function classifyTone(avg: Avg): "Warm" | "Cool" | "Unknown" {
    const {r, g, b} = avg;
    const score = r - b + (g - b) * 0.3;
    if (isNaN(score)) return "Unknown";
    return score >= 8 ? "Warm" : score <= -8 ? "Cool" : "Unknown";
}

function generatePalette(baseHex: string, tone: string) {
    // Create 4 swatches by shifting hue roughly toward warm or cool
    const rgb = hexToRgb(baseHex) || {r: 200, g: 160, b: 140};
    const out: string[] = [];
    for (let i = 0; i < 4; i++) {
        const factor = 1 - i * 0.14;
        let {r, g, b} = rgb;
        if (tone === "Warm") {
            r = clamp(Math.round(r * (1 + 0.06 * i)), 0, 255);
            g = clamp(Math.round(g * factor), 0, 255);
            b = clamp(Math.round(b * (factor * 0.9)), 0, 255);
        } else if (tone === "Cool") {
            r = clamp(Math.round(r * factor), 0, 255);
            g = clamp(Math.round(g * (1 + 0.05 * i)), 0, 255);
            b = clamp(Math.round(b * (1 + 0.08 * i)), 0, 255);
        } else {
            r = clamp(Math.round(r * factor), 0, 255);
            g = clamp(Math.round(g * factor), 0, 255);
            b = clamp(Math.round(b * factor), 0, 255);
        }
        out.push(rgbToHex(r, g, b));
    }
    return out;
}

function computeScore(avg: Avg) {
    const {r, g, b} = avg;
    if ([r, g, b].some((v) => typeof v !== "number" || isNaN(v))) return NaN;
    return r - b + (g - b) * 0.3;
}

function computeAccuracy(avg: Avg, undertone: string, hasFaceImage: boolean) {
    const score = computeScore(avg);
    if (isNaN(score) || undertone === "Unknown") return 55;
    const base = Math.min(90, Math.round(Math.min(1, Math.abs(score) / 25) * 80) + 20);
    const boost = hasFaceImage ? 10 : 0;
    return Math.min(99, base + boost);
}

function deriveSeason(avg: Avg, undertone: string) {
    const {r, g, b} = avg;
    const brightness = (r + g + b) / 3;
    if (undertone === "Warm") {
        if (brightness > 170) return {season: "Spring Warm", seasonLabelKR: "봄 웜톤"};
        return {season: "Autumn Warm", seasonLabelKR: "가을 웜톤"};
    }
    if (undertone === "Cool") {
        if (brightness > 160) return {season: "Summer Cool", seasonLabelKR: "여름 쿨톤"};
        return {season: "Winter Cool", seasonLabelKR: "겨울 쿨톤"};
    }
    return {season: "Unknown", seasonLabelKR: "알수없음"};
}

function clamp(v: number, a: number, b: number) {
    return Math.max(a, Math.min(b, v));
}

function hexToRgb(hex: string) {
    if (!hex) return null;
    const h = hex.replace(/^#/, "");
    if (h.length === 3) {
        return {
            r: parseInt(h[0] + h[0], 16),
            g: parseInt(h[1] + h[1], 16),
            b: parseInt(h[2] + h[2], 16),
        };
    }
    if (h.length === 6) {
        return {r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16)};
    }
    return null;
}

function rgbToHex(r: number, g: number, b: number) {
    return (
        "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")
    ).toUpperCase();
}


function normalizeToSchema(parsed: unknown, avg: Avg, baseHex: string, faceImage?: string | undefined) {
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    const toneCandidate = (p.tone || p.undertone || p.undertoneLabel || p.aiAnalysis?.skinUndertone || p.aiAnalysis?.skinTone || p.skinTone || p.seasonalTone) as string | undefined;
    let tone: "Warm" | "Cool" | "Unknown" = "Unknown";
    if (typeof toneCandidate === "string") {
        const t = toneCandidate.toLowerCase();
        if (t.includes("warm") || t.includes("웜")) tone = "Warm";
        else if (t.includes("cool") || t.includes("쿨")) tone = "Cool";
    }
    if (tone === "Unknown") {
        tone = classifyTone(avg);
    }

    let seasonalTone = (p.seasonalTone as string) || (p.seasonLabelKR as string) || (p.season as string) || null;
    if (!seasonalTone) {
        const s = deriveSeason(avg, tone);
        seasonalTone = s.seasonLabelKR || s.season || null;
    }

    let confidence: number | null = null;
    if (typeof (p.confidence) === "number") confidence = p.confidence as number;
    else if (typeof (p.accuracy) === "number") confidence = p.accuracy as number;
    else if (typeof (p.accuracy) === "string" && !isNaN(Number(p.accuracy as string))) confidence = Number(p.accuracy as string);
    if (confidence === null || isNaN(confidence)) {
        confidence = computeAccuracy(avg, tone, Boolean(faceImage));
    }
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));

    let recommended: string[] = [];
    if (Array.isArray(p.recommended) && p.recommended.length) recommended = p.recommended.slice();
    else if (Array.isArray(p.colors) && p.colors.length) recommended = p.colors.slice();
    else if (Array.isArray(p.palette) && p.palette.length) recommended = p.palette.slice();

    recommended = recommended.map((h) => normalizeHexString(String(h))).filter(Boolean) as string[];
    if (recommended.length < 4) {
        const generated = generatePalette(baseHex || "#BFA68A", tone);
        for (let i = 0; recommended.length < 4 && i < generated.length; i++) recommended.push(generated[i]);
    }
    recommended = recommended.slice(0, 4);

    const analysisSrc = (p.analysis as Record<string, unknown>) || (p.aiAnalysis as Record<string, unknown>) || {};
    const analysis = {
        skinTone: (analysisSrc.skinTone || analysisSrc.skinUndertone || (p.skinUndertone as string) || (tone === 'Warm' ? '웜' : tone === 'Cool' ? '쿨' : 'Unknown') || 'Unknown') as string,
        eyeColor: (analysisSrc.eyeColor || (p.eyeColor as string) || 'Unknown') as string,
        skinColorDescription: (analysisSrc.skinColorDescription || analysisSrc.skinToneHex || (p.skinColorDescription as string) || baseHex || '') as string,
    };

    return {
        seasonalTone: seasonalTone || '알수없음',
        tone,
        confidence,
        recommended,
        analysis,
    };
}

function normalizeHexString(raw: string) {
    if (!raw) return null;
    let s = raw.trim();
    // try to find a hex substring
    const m = s.match(/#?[0-9a-fA-F]{6}/);
    if (m) {
        s = m[0];
    }
    if (!s.startsWith('#')) s = '#' + s;
    if (/^#[0-9A-Fa-f]{6}$/.test(s)) return s.toUpperCase();
    return null;
}

// Extract a JSON substring from noisy text by finding the first '{' and the last '}' and returning that slice.
function extractJsonFromText(text: string): string | null {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    return text.slice(first, last + 1);
}


