import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { GmailClient } from "@/lib/gmail";
import { NextResponse } from "next/server";

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.accessToken) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const gmail = new GmailClient(session.accessToken);
        const labels = await gmail.getLabels();

        // Filter to only user-created labels (exclude system labels)
        const userLabels = labels
            .filter(l => l.type === "user")
            .map(l => ({
                id: l.id,
                name: l.name,
            }))
            .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

        return NextResponse.json({ labels: userLabels });
    } catch (error) {
        console.error("Failed to fetch labels:", error);
        return NextResponse.json({ error: "Failed to fetch labels" }, { status: 500 });
    }
}
