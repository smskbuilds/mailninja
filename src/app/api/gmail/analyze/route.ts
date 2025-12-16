import { getServerSession } from "next-auth/next";
import { authOptions } from "../../auth/[...nextauth]/route";

import { GmailClient, clusterByDomain, generateFilterSuggestions, isLikelyImportant, FilterSuggestion } from "@/lib/gmail";
import { gmail_v1 } from "googleapis";

// Helper to filter suggestions based on existing Gmail filters
function filterByExistingCriteria(suggestion: FilterSuggestion, existingFilters: gmail_v1.Schema$Filter[]): boolean {
    const fromCriteria = suggestion.criteria.from?.toLowerCase();
    if (!fromCriteria) return false;

    return existingFilters.some(filter => {
        const existingFrom = filter.criteria?.from?.toLowerCase();
        if (!existingFrom) return false;

        // Exact match
        if (existingFrom === fromCriteria) return true;

        // Check if suggestion is contained in a complex existing filter
        // e.g. existing: "from:(@foo.com OR @bar.com)" covers "from:@foo.com"
        if (existingFrom.includes(fromCriteria)) return true;

        return false;
    });
}

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.accessToken) {
        return new Response("Unauthorized", { status: 401 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const sendUpdate = (stage: string) => {
                const data = JSON.stringify({ type: "progress", stage });
                controller.enqueue(encoder.encode(data + "\n"));
            };

            const sendResult = (data: any) => {
                const result = JSON.stringify({ type: "result", data });
                controller.enqueue(encoder.encode(result + "\n"));
            };

            try {
                sendUpdate("Connecting to Gmail...");
                const gmail = new GmailClient(session.accessToken as string);

                // 1. Fetch recent messages
                let allMessages: any[] = [];
                const seenIds = new Set<string>();
                const targetCount = 1000;

                const categories = [
                    "category:primary in:inbox",
                    "category:updates in:inbox -category:primary",
                    "category:promotions in:inbox -category:primary -category:updates",
                    "category:social in:inbox -category:primary -category:updates -category:promotions",
                    "in:inbox -category:primary -category:updates -category:promotions -category:social" // Fallback
                ];

                let totalProcessed = 0;

                // Get true inbox stats first
                const inboxStats = await gmail.getInboxStats();
                sendUpdate(`Found ${inboxStats.total} total emails in inbox...`);

                sendUpdate(`Starting priority fetch (limit: ${targetCount} most recent)...`);

                for (const query of categories) {
                    if (allMessages.length >= targetCount) break;

                    const categoryName = query.split(' ')[0].replace('category:', '');
                    let pageToken: string | undefined = undefined;

                    // Keep fetching from this category until we hit the limit or run out of emails
                    while (allMessages.length < targetCount) {
                        const remaining = targetCount - allMessages.length;
                        const batchSize = Math.min(remaining, 500); // Gmail API limit is 500

                        sendUpdate(`Scanning ${categoryName} (Scanned ${totalProcessed} | Found ${allMessages.length}/${targetCount})...`);


                        // Fatigue detection
                        let consecutiveEmptyBatches = 0;

                        const { messages, nextPageToken } = await gmail.getMessages(batchSize, pageToken, query, (batchMessages, count) => {
                            // Process this batch immediately to update "Found" count
                            let batchAddedCount = 0;
                            for (const msg of batchMessages) {
                                if (!seenIds.has(msg.id)) {
                                    seenIds.add(msg.id);
                                    allMessages.push(msg);
                                    batchAddedCount++;
                                }
                            }

                            if (batchAddedCount === 0) {
                                consecutiveEmptyBatches++;
                            } else {
                                consecutiveEmptyBatches = 0;
                            }

                            const currentScanned = totalProcessed + count;
                            sendUpdate(`Scanning ${categoryName} (Scanned ${currentScanned} | Collected ${allMessages.length}/${targetCount} limit)`);
                        });

                        // Update totalProcessed for the next page
                        totalProcessed += messages.length;

                        // Check fatigue AFTER the batch processing
                        // If 5 batches (125 emails) yield 0 new results, stop this category.
                        if (consecutiveEmptyBatches >= 5) {
                            console.log(`Fatigue detected for ${categoryName}. Skipping remaining.`);
                            break;
                        }

                        // Note: We've already added the messages to allMessages in the callback above,
                        // so we don't need to loop through 'messages' again here.

                        // If no next page, stop this category.
                        // We intentionally DO NOT break on addedCount === 0, because we might be scanning
                        // a fallback category (in:inbox) which has many duplicates of previous categories.
                        // We need to keep paging through until we find new messages or run out of pages.
                        if (!nextPageToken) break;
                        pageToken = nextPageToken;
                    }
                }

                const messages = allMessages;
                sendUpdate(`Analyzed ${messages.length} messages. Checking filters...`);

                // 2. Fetch filters
                const [existingFilters, trustedSenders] = await Promise.all([
                    gmail.getFilters(),
                    (async () => {
                        try {
                            const fs = require('fs/promises');
                            const path = require('path');
                            const configPath = path.join(process.cwd(), 'trusted-senders.json');
                            const content = await fs.readFile(configPath, "utf-8");
                            const data = JSON.parse(content);
                            return new Set<string>(data.senders || []);
                        } catch (error) {
                            return new Set<string>();
                        }
                    })()
                ]);

                // 3. Filter actionable messages
                const actionableMessages = messages.filter(msg => {
                    const fromEmail = msg.fromEmail.toLowerCase();
                    if (trustedSenders.has(fromEmail)) return false;
                    return true;
                });

                sendUpdate("Clustering emails...");

                // 4. Cluster
                const clusters = clusterByDomain(actionableMessages);

                // 5. Generate suggestions
                let filterSuggestions = generateFilterSuggestions(clusters);

                // Filter out senders covered by existing filters
                filterSuggestions = filterSuggestions.filter(
                    s => !filterByExistingCriteria(s, existingFilters)
                );

                sendUpdate("Generating accurate counts...");

                // 6. Accurate counts
                const top10 = filterSuggestions.slice(0, 10);
                const suggestionsWithAccurateCounts = [];

                for (const suggestion of top10) {
                    try {
                        if (suggestion.criteria.from) {
                            // Sequential execution with a tiny delay to be safe
                            if (suggestionsWithAccurateCounts.length > 0) {
                                await new Promise(r => setTimeout(r, 200));
                            }

                            // Optimized lightweight count to get TOTAL
                            const { count, nextPageToken } = await gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox`, 500);
                            const isPlus = !!nextPageToken;
                            const countDisplay = isPlus ? "500+" : count.toString();

                            const description = suggestion.isGrouped && suggestion.senderDetails
                                ? `Auto-archive emails from ${suggestion.senderDetails.length} senders at ${suggestion.id.replace('filter-', '')} (~${countDisplay} messages)`
                                : `Auto-archive emails from ${suggestion.criteria.from} (~${countDisplay} messages)`;

                            // Fetch EXACT category counts to ensure dashboard badges are perfectly accurate
                            // We do this in parallel because we are only doing it for a few items and they are lightweight
                            const [primaryCount, updatesCount, promoCount, socialCount] = await Promise.all([
                                gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox category:primary`, 1).then(r => r.count === 0 ? 0 : gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox category:primary`, 500).then(r => r.count)),
                                gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox category:updates`, 1).then(r => r.count === 0 ? 0 : gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox category:updates`, 500).then(r => r.count)),
                                gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox category:promotions`, 1).then(r => r.count === 0 ? 0 : gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox category:promotions`, 500).then(r => r.count)),
                                gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox category:social`, 1).then(r => r.count === 0 ? 0 : gmail.getMessageCount(`from:${suggestion.criteria.from} in:inbox category:social`, 500).then(r => r.count))
                            ]);

                            // Note: We use a "Check 1 then Check Full" strategy above to save quota on empty categories

                            const exactMetrics = {
                                primary: primaryCount,
                                updates: updatesCount,
                                promotions: promoCount,
                                social: socialCount
                            };

                            suggestionsWithAccurateCounts.push({
                                ...suggestion,
                                matchCount: count,
                                description,
                                metrics: exactMetrics
                            });
                        } else {
                            suggestionsWithAccurateCounts.push(suggestion);
                        }
                    } catch (err) {
                        console.error(`Failed to get accurate count for suggestion ${suggestion.id}`, err);
                        // Fallback: push the original suggestion without accurate counts
                        suggestionsWithAccurateCounts.push(suggestion);
                    }
                }

                suggestionsWithAccurateCounts.sort((a, b) => {
                    const primaryA = a.metrics?.primary || 0;
                    const primaryB = b.metrics?.primary || 0;
                    if (primaryA !== primaryB) return primaryB - primaryA;
                    return b.matchCount - a.matchCount;
                });

                // Transform clusters for frontend (limit to 20 for performance)
                // 5. Sort by IMPACT (Primary emails count 3x more than Updates/Promotions)
                const topClusters = clusters
                    .sort((a, b) => {
                        const scoreA = (a.metrics?.primary || 0) * 3 + a.count;
                        const scoreB = (b.metrics?.primary || 0) * 3 + b.count;
                        return scoreB - scoreA;
                    })
                    .slice(0, 20);

                // Sequential to avoid rate limits
                const clusterData = [];
                for (const c of topClusters) {
                    try {
                        const estimate = await gmail.getMessageCountEstimate(
                            `from:${c.sender} in:inbox`
                        );
                        clusterData.push({
                            domain: c.domain,
                            sender: c.sender,
                            count: estimate,
                            countDisplay: estimate >= 500 ? "500+" : String(estimate),
                            suggestedAction: c.suggestedAction,
                            suggestedLabel: c.suggestedLabel,
                            messageIds: c.messages.map((m) => m.id),
                            metrics: c.metrics
                        });
                        // Tiny pause
                        await new Promise(r => setTimeout(r, 50));
                    } catch (e) {
                        // Fallback if estimate fails
                        clusterData.push({
                            domain: c.domain,
                            sender: c.sender,
                            count: c.messages.length, // Use local count
                            countDisplay: String(c.messages.length),
                            suggestedAction: c.suggestedAction,
                            suggestedLabel: c.suggestedLabel,
                            messageIds: c.messages.map((m) => m.id),
                            metrics: c.metrics
                        });
                    }
                }

                // Transform existing filters for frontend
                // Sequential to avoid rate limits
                const existingFiltersData = [];
                const relevantFilters = existingFilters.filter(f => f.criteria?.from).slice(0, 10);

                for (const f of relevantFilters) {
                    // We don't fetch counts for these to save API calls, just basic info
                    // Or if we do, we must be careful.
                    // For now, let's skip the count fetch for existing filters to save quota.
                    // The interface expects 'inboxCount', so we'll just put 0 or a placeholder.

                    existingFiltersData.push({
                        id: f.id!,
                        from: f.criteria?.from!,
                        action: f.action,
                        inboxCount: 0,
                        inboxCountDisplay: "-"
                    });
                }

                console.log(`Sending result with ${suggestionsWithAccurateCounts.length} suggestions and ${clusterData.length} clusters.`);

                const payload = {
                    stats: {
                        total: inboxStats.total,
                        unread: inboxStats.unread,
                        categories: inboxStats.categories,
                        isExact: inboxStats.isExact, // we fetched them, so it's exact-ish for this batch
                        clusters: clusters.length,
                        filterSuggestions: suggestionsWithAccurateCounts.length,
                    },
                    clusters: clusterData,
                    filterSuggestions: suggestionsWithAccurateCounts,
                    existingFilters: existingFiltersData
                };

                const resultString = JSON.stringify({ type: "result", data: payload });
                console.log(`Payload size: ${resultString.length} bytes`);

                controller.enqueue(encoder.encode(resultString + "\n"));
                controller.close();

            } catch (error: any) {
                console.error("Stream error:", error);
                const errorMessage = error?.message || String(error);
                const errorJson = JSON.stringify({ type: "error", message: `Analysis failed: ${errorMessage}` });
                controller.enqueue(encoder.encode(errorJson + "\n"));
                controller.close();
            }
        }
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    });
}
