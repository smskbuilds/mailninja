import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { GmailClient } from "@/lib/gmail";
import { NextRequest, NextResponse } from "next/server";

interface ActionRequest {
    action: "archive" | "createFilter" | "applyLabel" | "archiveFromSender" | "labelAndFilter";
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
    archiveExisting?: boolean;
    sender?: string;
    labelName?: string;
    skipInbox?: boolean;
}

// Helper for streaming responses
function createStreamResponse(
    process: (controller: ReadableStreamDefaultController, sendUpdate: (msg: string) => void) => Promise<any>
) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const sendUpdate = (stage: string) => {
                const data = JSON.stringify({ type: "progress", stage });
                controller.enqueue(encoder.encode(data + "\n"));
            };

            try {
                const result = await process(controller, sendUpdate);
                const finalData = JSON.stringify({ type: "result", data: result });
                controller.enqueue(encoder.encode(finalData + "\n"));
                controller.close();
            } catch (error: any) {
                console.error("Action error:", error);
                const errorData = JSON.stringify({ type: "error", error: error.message || "Unknown error" });
                controller.enqueue(encoder.encode(errorData + "\n"));
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
    });
}

export async function POST(request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.accessToken) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: ActionRequest = await request.json();
    const gmail = new GmailClient(session.accessToken);

    return createStreamResponse(async (controller, sendUpdate) => {
        switch (body.action) {
            case "archive": {
                if (!body.messageIds || body.messageIds.length === 0) {
                    throw new Error("No message IDs provided");
                }
                sendUpdate(`Archiving ${body.messageIds.length} messages...`);
                await gmail.archiveMessages(body.messageIds);
                return { success: true, message: `Archived ${body.messageIds.length} messages` };
            }

            case "createFilter": {
                if (!body.criteria || !body.filterAction) {
                    throw new Error("Filter criteria and action required");
                }

                sendUpdate("Creating filter...");
                const filter = await gmail.createFilter(
                    { from: body.criteria.from },
                    {
                        removeLabelIds: body.filterAction.skipInbox ? ["INBOX"] : undefined,
                        addLabelIds: body.filterAction.addLabel ? [body.filterAction.addLabel] : undefined,
                    }
                );

                // Archive existing emails from this sender if requested
                let archivedCount = 0;
                if (body.archiveExisting && body.criteria.from) {
                    sendUpdate("Scanning for existing emails...");

                    // Collect ALL message IDs first (faster than fetch-archive-fetch-archive)
                    const allMessageIds: string[] = [];
                    let hasMore = true;
                    let pageToken: string | undefined;

                    while (hasMore) {
                        const { messages, nextPageToken } = await gmail.getMessages(
                            1000, // Use max batch size
                            pageToken,
                            `from:${body.criteria.from} in:inbox`,
                            (batch, total) => {
                                sendUpdate(`Finding emails to archive... (${allMessageIds.length + total} found)`);
                            }
                        );

                        allMessageIds.push(...messages.map(m => m.id));
                        pageToken = nextPageToken;
                        hasMore = !!nextPageToken;
                    }

                    // Archive all at once with parallel batching
                    if (allMessageIds.length > 0) {
                        sendUpdate(`Archiving ${allMessageIds.length} emails...`);
                        await gmail.archiveMessages(allMessageIds, (archived, total) => {
                            sendUpdate(`Archiving... (${archived}/${total})`);
                        });
                        archivedCount = allMessageIds.length;
                    }
                }

                return {
                    success: true,
                    filter,
                    archivedCount,
                    message: `Filter created successfully${archivedCount > 0 ? ` and archived ${archivedCount} emails` : ""}`
                };
            }

            case "applyLabel": {
                if (!body.messageIds || !body.labelId) {
                    throw new Error("Message IDs and label ID required");
                }
                sendUpdate("Applying label...");
                // Fix: use applyLabel instead of batchModifyMessages
                await gmail.applyLabel(body.messageIds, body.labelId);
                return { success: true, message: "Label applied successfully" };
            }

            case "archiveFromSender": {
                if (!body.sender) {
                    throw new Error("Sender email required");
                }

                sendUpdate(`Scanning emails from ${body.sender}...`);

                // Collect ALL message IDs first
                const allMessageIds: string[] = [];
                let hasMore = true;
                let pageToken: string | undefined;

                while (hasMore) {
                    const { messages, nextPageToken } = await gmail.getMessages(
                        1000, // Use max batch size
                        pageToken,
                        `from:${body.sender} in:inbox`,
                        (batch, total) => {
                            sendUpdate(`Finding emails to archive... (${allMessageIds.length + total} found)`);
                        }
                    );

                    allMessageIds.push(...messages.map(m => m.id));
                    pageToken = nextPageToken;
                    hasMore = !!nextPageToken;
                }

                // Archive all at once with parallel batching
                let archivedCount = 0;
                if (allMessageIds.length > 0) {
                    sendUpdate(`Archiving ${allMessageIds.length} emails...`);
                    await gmail.archiveMessages(allMessageIds, (archived, total) => {
                        sendUpdate(`Archiving... (${archived}/${total})`);
                    });
                    archivedCount = allMessageIds.length;
                }

                return {
                    success: true,
                    archivedCount,
                    message: `Archived ${archivedCount} emails from ${body.sender}`
                };
            }

            case "labelAndFilter": {
                if (!body.criteria?.from || !body.labelName) {
                    throw new Error("Sender criteria and label name required");
                }

                const skipInbox = body.skipInbox !== false; // Default true

                // 1. Get or create the label
                sendUpdate(`Getting or creating label: ${body.labelName}...`);
                const labelId = await gmail.getOrCreateLabel(body.labelName);

                // 2. Create Gmail filter for future messages
                sendUpdate("Creating filter for future messages...");
                await gmail.createFilter(
                    { from: body.criteria.from },
                    {
                        addLabelIds: [labelId],
                        removeLabelIds: skipInbox ? ["INBOX"] : undefined,
                    }
                );

                // 3. Find and label existing messages
                sendUpdate("Finding existing messages...");
                const allMessageIds: string[] = [];
                let hasMore = true;
                let pageToken: string | undefined;

                while (hasMore) {
                    const { messages, nextPageToken } = await gmail.getMessages(
                        500,
                        pageToken,
                        `from:${body.criteria.from} in:inbox`,
                        (batch, total) => {
                            sendUpdate(`Finding messages... (${allMessageIds.length + total} found)`);
                        }
                    );

                    allMessageIds.push(...messages.map(m => m.id));
                    pageToken = nextPageToken;
                    hasMore = !!nextPageToken;
                }

                // 4. Apply label and optionally archive
                let labeledCount = 0;
                if (allMessageIds.length > 0) {
                    sendUpdate(`Applying label to ${allMessageIds.length} messages...`);
                    await gmail.applyLabel(allMessageIds, labelId);
                    labeledCount = allMessageIds.length;

                    if (skipInbox) {
                        sendUpdate(`Archiving ${allMessageIds.length} messages...`);
                        await gmail.archiveMessages(allMessageIds, (archived, total) => {
                            sendUpdate(`Archiving... (${archived}/${total})`);
                        });
                    }
                }

                return {
                    success: true,
                    labeledCount,
                    labelName: body.labelName,
                    message: `Created filter and labeled ${labeledCount} emails${skipInbox ? " (archived)" : ""}`
                };
            }

            default:
                throw new Error("Invalid action");
        }
    });
}
