import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { GmailClient, clusterByDomain, generateFilterSuggestions } from "@/lib/gmail";
import { NextResponse } from "next/server";

export async function GET() {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.accessToken) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const gmail = new GmailClient(session.accessToken);

        // Get inbox stats (detects if category tabs are enabled)
        const stats = await gmail.getInboxStats();
        console.log("Inbox stats:", {
            total: stats.total,
            unread: stats.unread,
            isExact: stats.isExact,
            hasCategoryTabs: stats.hasCategoryTabs
        });

        // Use category:primary query if tabs are enabled to match Gmail UI
        const messageQuery = stats.hasCategoryTabs
            ? "in:inbox category:primary"
            : "in:inbox";

        // Fetch messages for analysis (limit to 200 for performance)
        const { messages } = await gmail.getMessages(200, undefined, messageQuery);
        console.log("Messages fetched:", messages.length);

        // Cluster by sender
        const clusters = clusterByDomain(messages);

        // Generate filter suggestions
        let filterSuggestions = generateFilterSuggestions(clusters);

        // Get accurate counts for filter suggestions (our sample of 200 messages may undercount)
        const suggestionsWithAccurateCounts = await Promise.all(
            filterSuggestions.map(async (suggestion) => {
                if (suggestion.criteria.from) {
                    // Get estimated count from Gmail for this sender (fast)
                    const accurateCount = await gmail.getMessageCountEstimate(
                        `from:${suggestion.criteria.from} in:inbox`
                    );
                    return {
                        ...suggestion,
                        matchCount: accurateCount,
                        description: `Auto-archive emails from ${suggestion.criteria.from} (${accurateCount} messages)`,
                    };
                }
                return suggestion;
            })
        );

        // Transform clusters for frontend (include message IDs for actions)
        const clusterData = clusters.map((c) => ({
            domain: c.domain,
            sender: c.sender,
            count: c.count,
            suggestedAction: c.suggestedAction,
            suggestedLabel: c.suggestedLabel,
            messageIds: c.messages.map((m) => m.id),
        }));

        return NextResponse.json({
            stats: {
                total: stats.total,
                unread: stats.unread,
                isExact: stats.isExact,
                clusters: clusters.length,
                filterSuggestions: suggestionsWithAccurateCounts.length,
            },
            clusters: clusterData,
            filterSuggestions: suggestionsWithAccurateCounts,
        });
    } catch (error) {
        console.error("Analysis error:", error);
        return NextResponse.json(
            { error: "Failed to analyze inbox" },
            { status: 500 }
        );
    }
}
