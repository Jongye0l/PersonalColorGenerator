"use client";

import React, {CSSProperties, useRef, useState} from "react";

type Result = {
    // 예: "겨울 쿨톤", "봄 웜톤"
    seasonalTone?: string;
    // 기본 톤 (간단 표기)
    tone: "Warm" | "Cool" | "Unknown";
    // 신뢰도(0-100)
    confidence?: number;
    // 추천 색상 (헥스) - 클라이언트에서는 최대 4개만 표시합니다
    recommended: string[];
    // AI가 제공한 상세 분석
    analysis?: {
        skinTone?: string; // 예: '웜', '쿨'
        eyeColor?: string; // 예: '갈색'
        skinColorDescription?: string; // 예: '밝은 올리브 톤'
    };
};

export default function Home() {
    const [state, setState] = useState<number>(0);
    const [preview, setPreview] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<Result | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        setPreview(url);
        setResult(null);
        await processImage(file);
    }

    async function processImage(file: File) {
        setState(1);
        try {
            const img = await loadImageFromFile(file);

            const base64 = await toBase64(file);

            let box: null | { x: number; y: number; width: number; height: number } = null;
            try {
                const apiRes = await fetch("/api/face-detect", {
                    method: "POST",
                    headers: {"content-type": "application/json"},
                    body: JSON.stringify({image: base64, width: img.naturalWidth, height: img.naturalHeight}),
                });
                const apiJson = await apiRes.json();
                if (apiJson?.box && typeof apiJson.box === "object") {
                    box = apiJson.box as { x: number; y: number; width: number; height: number };
                }
            } catch (e) {
                console.warn("face-detect API failed", e);
            }

            if (!box) {
                try {
                    const canvasForDetect = document.createElement("canvas");
                    canvasForDetect.width = img.naturalWidth;
                    canvasForDetect.height = img.naturalHeight;
                    const ctx = canvasForDetect.getContext("2d");
                    if (ctx) ctx.drawImage(img, 0, 0);
                    type FDClass = { new(): { detect: (input: unknown) => Promise<unknown[]> } };
                    const Win = window as unknown as { FaceDetector?: FDClass };
                    if (typeof Win.FaceDetector === "function") {
                        const detector = new Win.FaceDetector();
                        const detections = await detector.detect(canvasForDetect as unknown);
                        if (Array.isArray(detections) && detections.length) {
                            const first = detections[0] as unknown;
                            if (typeof first === "object" && first !== null && "boundingBox" in first) {
                                const d = (first as {
                                    boundingBox: { x: number; y: number; width: number; height: number }
                                }).boundingBox;
                                box = {x: d.x, y: d.y, width: d.width, height: d.height};
                            }
                        }
                    }
                } catch {
                    // ignore
                }
            }

            if (!box) {
                const size = Math.min(img.naturalWidth, img.naturalHeight) * 0.5;
                box = {
                    x: img.naturalWidth / 2 - size / 2,
                    y: img.naturalHeight / 2 - size / 2,
                    width: size,
                    height: size,
                };
            }

            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("No 2d context");
            ctx.drawImage(img, 0, 0);

            const x = Math.max(0, Math.floor(box.x));
            const y = Math.max(0, Math.floor(box.y));
            const w = Math.max(1, Math.floor(Math.min(box.width, canvas.width - x)));
            const h = Math.max(1, Math.floor(Math.min(box.height, canvas.height - y)));

            const sample = ctx.getImageData(x, y, w, h);
            const avg = averageRGB(sample.data);
            const hex = rgbToHex(avg.r, avg.g, avg.b);
            const cropCanvas = document.createElement("canvas");
            cropCanvas.width = w;
            cropCanvas.height = h;
            const cropCtx = cropCanvas.getContext("2d");
            if (!cropCtx) throw new Error("No 2d context for crop");
            cropCtx.drawImage(img, x, y, w, h, 0, 0, w, h);

            function compressCanvasToDataUrl(src: HTMLCanvasElement, maxBytes = 45000) {
                const tmp = document.createElement("canvas");
                const ctx = tmp.getContext("2d");
                if (!ctx) return src.toDataURL("image/jpeg", 0.7);
                let sw = src.width;
                let sh = src.height;
                tmp.width = sw;
                tmp.height = sh;
                ctx.drawImage(src, 0, 0);

                let quality = 0.85;
                let out = tmp.toDataURL("image/jpeg", quality);
                while (out.length > maxBytes && quality > 0.2) {
                    quality = Math.max(0.2, quality * 0.7);
                    out = tmp.toDataURL("image/jpeg", quality);
                }

                let currentMax = Math.max(sw, sh);
                while (out.length > maxBytes && currentMax > 64) {
                    currentMax = Math.floor(currentMax * 0.75);
                    const scale = currentMax / Math.max(sw, sh);
                    const nw = Math.max(1, Math.round(sw * scale));
                    const nh = Math.max(1, Math.round(sh * scale));
                    const resized = document.createElement("canvas");
                    resized.width = nw;
                    resized.height = nh;
                    const rctx = resized.getContext("2d");
                    if (!rctx) break;
                    rctx.drawImage(src, 0, 0, sw, sh, 0, 0, nw, nh);

                    // draw resized into tmp and re-encode
                    tmp.width = nw;
                    tmp.height = nh;
                    ctx.clearRect(0, 0, nw, nh);
                    ctx.drawImage(resized, 0, 0);
                    quality = Math.max(0.2, quality * 0.7);
                    out = tmp.toDataURL("image/jpeg", quality);
                    sw = nw;
                    sh = nh;
                }
                return out;
            }

            const faceDataUrl = compressCanvasToDataUrl(cropCanvas, 45000);
            try {
                console.log("[client] faceDataUrl size:", faceDataUrl.length);
            } catch {
            }

            try {
                const debugFaceInfo = faceDataUrl ? {
                    length: faceDataUrl.length,
                    prefix: faceDataUrl.slice(0, 100)
                } : null;
                console.log("[client] /api/ai-classify request ->", {avg, hex, faceImage: debugFaceInfo});
            } catch {
            }

            const res = await fetch("/api/ai-classify", {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({avg, hex, faceImage: faceDataUrl}),
            });
            const json = await res.json();
            try {
                console.log("[client] /api/ai-classify response ->", json);
            } catch {
            }
            setResult(json as Result);
            setState(2);
        } catch (err) {
            setState(1);
            console.error(err);
            setResult({
                seasonalTone: undefined,
                tone: "Unknown",
                confidence: 0,
                recommended: [],
                analysis: {skinTone: "", eyeColor: "", skinColorDescription: ""},
            });
        }
    }

    if (state == 0) {
        const guides = [
            "정면을 바라봐 주세요.",
            "안경을 벗어 주세요.",
            "밝은 곳에서 촬영해 주세요."
        ];

        const styles = {
            overlay: {
                position: 'fixed',
                top: 0, left: 0, right: 0, bottom: 0,
                width: '100vw', height: '100vh',
                backgroundColor: '#000000', // 완전 블랙으로 통일
                display: 'flex', justifyContent: 'center', alignItems: 'center',
                fontFamily: 'sans-serif',
                boxSizing: 'border-box',
                overflow: 'hidden'
            } as CSSProperties,
            container: {
                width: '100%', height: '100%',
                maxWidth: '430px', // 모바일 가로폭 밸런스 유지용
                backgroundColor: '#000000',
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                padding: '40px 32px',
                color: '#ffffff',
                boxSizing: 'border-box'
            } as CSSProperties,
            header: {
                width: '100%', pt: '16px'
            } as CSSProperties,
            title: {
                fontSize: '26px',
                fontWeight: 'bold',
                letterSpacing: '-0.03em',
                margin: '16px 0 0 0',
                textAlign: 'center'
            } as CSSProperties,
            // 카메라 영역 박스는 원본대로 아주 부드러운 라운딩 유지
            cameraBox: {
                width: '280px', height: '350px',
                backgroundColor: '#4E4E4E',
                borderRadius: '32px', // 중앙 회색 박스 고정 곡률
                border: '1px solid #3f3f46',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: 'auto auto'
            } as CSSProperties,
            cameraText: {
                color: '#a1a1aa', fontSize: '14px', fontWeight: '500'
            } as CSSProperties,
            guideList: {
                width: '240px', margin: '0 auto 40px auto',
                display: 'flex', flexDirection: 'column', gap: '16px'
            } as CSSProperties,
            guideItem: {
                display: 'flex', alignItems: 'center', gap: '16px'
            } as CSSProperties,
            circle: {
                width: '18px', height: '18px',
                borderRadius: '50%', border: '2px solid #ffffff',
                flexShrink: 0
            } as CSSProperties,
            guideText: {
                fontSize: '15px', fontWeight: '500', color: '#ffffff', letterSpacing: '-0.02em'
            } as CSSProperties,
            btnContainer: {
                width: '100%', paddingBottom: '16px', display: 'flex', justifyContent: 'center'
            } as CSSProperties,
            button: {
                width: '280px', padding: '16px 0', // 버튼 가로폭도 다른 요소들과 대칭 맞춤
                backgroundColor: '#ffffff', color: '#000000',
                fontSize: '18px', fontWeight: 'bold',
                borderRadius: '16px', border: 'none',
                cursor: 'pointer', transition: 'background 0.15s'
            } as CSSProperties
        };

        return (
            <div style={styles.overlay}>
                <div style={styles.container}>

                    {/* [상단] 타이틀 */}
                    <header style={styles.header}>
                        <h2 style={styles.title}>퍼스널 컬러 진단</h2>
                    </header>

                    {/* [중앙] 카메라 영역 네모 (곡률 정상 작동) */}
                    <div style={styles.cameraBox}>
                    </div>

                    {/* [하단] 가이드 리스트 */}
                    <div style={styles.guideList}>
                        {guides.map((text, index) => (
                            <div key={index} style={styles.guideItem}>
                                <div style={styles.circle}/>
                                <span style={styles.guideText}>{text}</span>
                            </div>
                        ))}
                    </div>

                    {/* [최하단] 촬영하기 버튼 */}
                    <div style={styles.btnContainer}>
                        <input ref={inputRef} type="file" accept="image/*" capture="environment" onChange={handleFile}
                               className="hidden"/>
                        <button
                            type="button"
                            style={styles.button}
                            onClick={() => inputRef.current?.click()}
                            onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f4f4f5'}
                            onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#ffffff'}
                        >
                            촬영 하기
                        </button>
                    </div>

                </div>
            </div>
        );
    }

    if (state == 1) {
        const styles = {
            overlay: {
                position: 'fixed',
                top: 0, left: 0, right: 0, bottom: 0,
                width: '100vw', height: '100vh',
                backgroundColor: '#000000', // 완전 블랙
                display: 'flex', justifyContent: 'center', alignItems: 'center',
                fontFamily: 'sans-serif',
                boxSizing: 'border-box',
                overflow: 'hidden',
                zIndex: 9999
            } as CSSProperties,
            container: {
                width: '100%', height: '100%',
                maxWidth: '430px',
                display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
                padding: '32px',
                color: '#ffffff',
                boxSizing: 'border-box'
            } as CSSProperties,
            textGroup: {
                textAlign: 'center',
                display: 'flex', flexDirection: 'column', gap: '16px'
            } as CSSProperties,
            mainText: {
                fontSize: '22px',
                fontWeight: 'bold',
                color: '#ffffff',
                letterSpacing: '-0.03em',
                margin: 0,
                lineHeight: '1.4'
            } as CSSProperties,
            subText: {
                fontSize: '15px',
                fontWeight: '500',
                color: '#ffffff',
                letterSpacing: '-0.02em',
                margin: 0,
                lineHeight: '1.4'
            } as CSSProperties
        };

        return (
            <div style={styles.overlay}>
                <div style={styles.container}>
                    <div style={styles.textGroup}>
                        <p style={styles.mainText}>...AI가 얼굴을 분석하고 있어요!</p>
                        <p style={styles.subText}>약 3~5초 정도 소요됩니다.</p>
                    </div>

                </div>
            </div>
        );
    }

    {
        const styles = {
            overlay: {
                position: 'fixed',
                top: 0, left: 0, right: 0, bottom: 0,
                width: '100vw', height: '100vh',
                backgroundColor: '#F5F5F5',
                display: 'flex', justifyContent: 'center', alignItems: 'center',
                fontFamily: 'sans-serif',
                boxSizing: 'border-box',
                overflow: 'hidden',
                zIndex: 10
            } as CSSProperties,
            container: {
                width: '100%', height: '100%',
                maxWidth: '430px',
                backgroundColor: '#ffffff',
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                padding: '50px 36px 40px 36px',
                boxSizing: 'border-box'
            } as CSSProperties,
            titleSection: {
                textAlign: 'center', margin: '20px 0 10px 0'
            } as CSSProperties,
            mainTitle: {
                fontSize: '28px', fontWeight: 'bold', color: '#000000', margin: '0 0 24px 0', letterSpacing: '-0.03em'
            } as CSSProperties,
            toneResult: {
                fontSize: '22px',
                fontWeight: 'bold',
                color: '#2563EB',
                margin: '0 0 16px 0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
            } as CSSProperties,
            accuracy: {
                fontSize: '14px', fontWeight: '500', color: '#a1a1aa', letterSpacing: '0.1em', margin: 0
            } as CSSProperties,
            sectionTitle: {
                fontSize: '16px', fontWeight: 'bold', color: '#000000', textAlign: 'center', margin: '0 0 16px 0'
            } as CSSProperties,
            chipGroup: {
                display: 'flex', justifyContent: 'center', gap: '10px', marginBottom: '36px'
            } as CSSProperties,
            chip: {
                width: '42px', height: '42px', borderRadius: '8px', flexShrink: 0
            } as CSSProperties,
            infoTable: {
                width: '200px', margin: '0 auto 20px auto', display: 'flex', flexDirection: 'column', gap: '14px'
            } as CSSProperties,
            infoRow: {
                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            } as CSSProperties,
            infoLabel: {
                fontSize: '15px', fontWeight: '600', color: '#4b5563'
            } as CSSProperties,
            infoValue: {
                fontSize: '15px', fontWeight: 'bold', color: '#000000'
            } as CSSProperties,
            btnContainer: {
                width: '100%', display: 'flex', justifyContent: 'center'
            } as CSSProperties,
            button: {
                width: '260px', padding: '16px 0',
                backgroundColor: '#000000', color: '#ffffff',
                fontSize: '18px', fontWeight: 'bold',
                borderRadius: '14px', border: 'none',
                cursor: 'pointer'
            } as CSSProperties
        };

        if (result == undefined) return null;

        return (
            <div style={styles.overlay}>
                <div style={styles.container}>

                    <div style={styles.titleSection}>
                        <h1 style={styles.mainTitle}>당신의 퍼스널 컬러는?</h1>
                        <div style={styles.toneResult}>
                            {result.seasonalTone ?? (result.tone === 'Unknown' ? '판별 불가' : `${result.tone === 'Warm' ? '웜톤' : '쿨톤'}`)}
                        </div>
                        <p style={styles.accuracy}>--- 정확도 {Math.round(result.confidence as number)}% ---</p>
                    </div>

                    {/* 중간 추천 컬러 & 데이터 결과 구역 */}
                    <div>
                        <h3 style={styles.sectionTitle}>추천 컬러</h3>
                        <div style={styles.chipGroup}>
                            {result.recommended.slice(0, 4).map((c) => (
                                <div key={c}
                                     style={{...styles.chip, background: c}} title={c}>
                                </div>
                            ))}
                        </div>

                        <h3 style={styles.sectionTitle}>AI 분석 결과</h3>
                        <div style={styles.infoTable}>
                            <div style={styles.infoRow}>
                                <span style={styles.infoLabel}>피부톤</span>
                                <span style={styles.infoValue}>{result.analysis?.skinTone ?? '—'}</span>
                            </div>
                            <div style={styles.infoRow}>
                                <span style={styles.infoLabel}>눈동자</span>
                                <span style={styles.infoValue}>{result.analysis?.eyeColor ?? '—'}</span>
                            </div>
                            <div style={styles.infoRow}>
                                <span style={styles.infoLabel}>피부톤</span>
                                <span style={styles.infoValue}>{result.analysis?.skinColorDescription ?? '—'}</span>
                            </div>
                        </div>
                    </div>

                    {/* 하단 버튼 구역 */}
                    <div style={styles.btnContainer}>
                        <button style={styles.button} onClick={() => console.log('스타일 추천 페이지 이동')}>
                            스타일 추천
                        </button>
                    </div>

                </div>
            </div>
        );
    }
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = document.createElement("img");
        img.onload = () => {
            resolve(img as HTMLImageElement);
            URL.revokeObjectURL(url);
        };
        img.onerror = (e: Event | string) => reject(new Error(String(e)));
        img.src = url;
    });
}

// helper: file -> base64 data URL
function toBase64(file: File): Promise<string> {
    return new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === "string") res(reader.result);
            else rej(new Error("Failed to convert file to base64"));
        };
        reader.onerror = rej;
        reader.readAsDataURL(file);
    });
}

function averageRGB(data: Uint8ClampedArray) {
    let r = 0,
        g = 0,
        b = 0,
        count = 0;
    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
    }
    if (count === 0) return {r: 0, g: 0, b: 0};
    return {r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count)};
}

function rgbToHex(r: number, g: number, b: number) {
    return (
        "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")
    ).toUpperCase();
}

