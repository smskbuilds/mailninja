import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { GmailClient } from "@/lib/gmail";
import { NextRequest, NextResponse } from "next/server";

interface ActionRequest {
    action: "archive" | "createFilter" | "applyLabel";
    messageIds?: string[];
    criteria?: {
        from?: string;
        subject?: string;
    };
    filterAction?: {
        skipInbox?: boolean;
        addLabel?: string;
    };
    labelId?: string;
}

export async function POST(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.accessToken) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body: ActionRequest = await request.json();
        const gmail = new GmailClient(session.accessToken);

        switch (body.action) {
            case "archive": {
                if (!body.messageIds || body.messageIds.length === 0) {
                    return NextResponse.json(
                        { error: "No message IDs provided" },
                        { status: 400 }
                    );
                }
                await gmail.archiveMessages(body.messageIds);
                return NextResponse.json({
                    success: true,
                    message: `Archived ${body.messageIds.length} messages`
                });
            }

            case "createFilter": {
                if (!body.criteria || !body.filterAction) {
                    return NextResponse.json(
                        { error: "Filter criteria and action required" },
                        { status: 400 }
                    );
                }

                const filter = await gmail.createFilter(
                    { from: body.criteria.from },
                    {
                        removeLabelIds: body.filterAction.skipInbox ? ["INBOX"] : undefined,
                        addLabelIds: body.filterAction.addLabel ? [body.filterAction.addLabel] : undefined,
                    }
                );

                return NextResponse.json({
                    success: true,
                    filter,
                    message: "Filter created successfully"
                });
            }

            case "applyLabel": {
                if (!body.messageIds || !body.labelId) {
                    return NextResponse.json(
                        { error: "Message IDs and label ID required" },
                        { status: 400 }
                    );
                }
                await gmail.applyLabel(body.messageIds, body.labelId);
                return NextResponse.json({
                    success: true,
                    message: `Applied label to ${body.messageIds.length} messages`
                });
            }

            default:
                return NextResponse.json(
                    { error: "Invalid action" },
                    { status: 400 }
                );
        }
    } catch (error) {
        console.error("Action error:", error);
        return NextResponse.json(
            { error: "Failed to execute action" },
            { status: 500 }
        );
    }
}
