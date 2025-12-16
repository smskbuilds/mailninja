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

        // Get existing filters to exclude from suggestions
        const existingFilters = await gmail.getFilters();
        const existingFilterSenders = new Set(
            existingFilters
                .map(f => f.criteria?.from?.toLowerCase())
                .filter((from): from is string => !!from)
        );

        // Generate filter suggestions (excluding senders that already have filters)
        let filterSuggestions = generateFilterSuggestions(clusters);
        filterSuggestions = filterSuggestions.filter(
            s => !existingFilterSenders.has(s.criteria.from?.toLowerCase() || "")
        );

        // Get exact message counts for filter suggestions (only 5, so worth the accuracy)
        const top5 = filterSuggestions.slice(0, 5);
        const suggestionsWithAccurateCounts = await Promise.all(
            top5.map(async (suggestion) => {
                if (suggestion.criteria.from) {
                    const exactCount = await gmail.getMessageCount(
                        `from:${suggestion.criteria.from} in:inbox`
                    );
                    return {
                        ...suggestion,
                        matchCount: exactCount,
                        description: `Auto-archive emails from ${suggestion.criteria.from} (${exactCount} messages)`,
                    };
                }
                return suggestion;
            })
        );

        // Sort by message count descending (highest first)
        suggestionsWithAccurateCounts.sort((a, b) => b.matchCount - a.matchCount);

        // Transform clusters for frontend with accurate counts (using fast estimate)
        const clusterData = await Promise.all(
            clusters.slice(0, 10).map(async (c) => {
                const estimate = await gmail.getMessageCountEstimate(
                    `from:${c.sender} in:inbox`
                );
                return {
                    domain: c.domain,
                    sender: c.sender,
                    count: estimate,
                    countDisplay: estimate >= 200 ? "200+" : String(estimate),
                    suggestedAction: c.suggestedAction,
                    suggestedLabel: c.suggestedLabel,
                    messageIds: c.messages.map((m) => m.id),
                };
            })
        );

        // Transform existing filters for frontend (use exact counts since accuracy matters)
        const existingFiltersData = await Promise.all(
            existingFilters
                .filter(f => f.criteria?.from)
                .slice(0, 10) // Limit to 10 for performance with exact counting
                .map(async (f) => {
                    const from = f.criteria?.from || "";
                    // Use exact count for active filters since users need accurate numbers
                    const inboxCount = await gmail.getMessageCount(`from:${from} in:inbox`);
                    return {
                        id: f.id,
                        from,
                        action: f.action,
                        inboxCount,
                        inboxCountDisplay: String(inboxCount),
                    };
                })
        );

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
            existingFilters: existingFiltersData,
        });
    } catch (error) {
        console.error("Analysis error:", error);
        return NextResponse.json(
            { error: "Failed to analyze inbox" },
            { status: 500 }
        );
    }
}
