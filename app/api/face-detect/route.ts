import {NextResponse} from "next/server";

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const imageData: string | undefined = body.image; // data URL
        const width: number | undefined = body.width;
        const height: number | undefined = body.height;

        // If user configured an external face-detect API, proxy the request.
        const FACE_URL = process.env.FACE_API_URL;
        const FACE_KEY = process.env.FACE_API_KEY;

        if (FACE_URL && imageData) {
            try {
                const resp = await fetch(FACE_URL, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        ...(FACE_KEY ? {Authorization: `Bearer ${FACE_KEY}`} : {}),
                    },
                    body: JSON.stringify({image: imageData, width, height}),
                });
                const data = await resp.json();
                // Expect external API to return { box: { x,y,width,height } }
                return NextResponse.json(data);
            } catch (e) {
                console.error("External face API failed", e);
                // fallthrough to local fallback
            }
        }

        // Local fallback: return a centered box based on provided dimensions (if any)
        const w = typeof width === "number" && width > 0 ? width : 800;
        const h = typeof height === "number" && height > 0 ? height : 800;
        const boxSize = Math.floor(Math.min(w, h) * 0.35);
        const fakeBox = {
            x: Math.floor(w / 2 - boxSize / 2),
            y: Math.floor(h / 2 - boxSize / 2),
            width: boxSize,
            height: boxSize,
        };

        return NextResponse.json({box: fakeBox});
    } catch (err) {
        console.error(err);
        return NextResponse.json({error: "server error"}, {status: 500});
    }
}

