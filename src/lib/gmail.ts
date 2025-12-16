import { google, gmail_v1 } from "googleapis";

export interface EmailMessage {
    id: string;
    threadId: string;
    snippet: string;
    subject: string;
    from: string;
    fromEmail: string;
    fromDomain: string;
    date: Date;
    labelIds: string[];
    isUnread: boolean;
}

export interface SenderInfo {
    email: string;
    count: number;
    shouldArchive: boolean;  // AI recommendation
    reason: string;          // Why this recommendation
}

export interface EmailCluster {
    domain: string;
    sender: string;
    count: number;
    messages: EmailMessage[];
    suggestedAction: "archive" | "label" | "keep" | "filter";
    suggestedLabel?: string;
    allSenders?: string[];  // All unique senders in this cluster (for grouped domains)
    isGrouped?: boolean;    // Whether this cluster groups multiple subdomains
    senderDetails?: SenderInfo[];  // Detailed sender info with recommendations
    metrics?: {
        primary: number;
        promotions: number;
        social: number;
        updates: number;
    };
}

export interface FilterSuggestion {
    id: string;
    criteria: {
        from?: string;
        subject?: string;
        hasWords?: string;
    };
    action: {
        skipInbox?: boolean;
        addLabel?: string;
        archive?: boolean;
        markRead?: boolean;
    };
    matchCount: number;
    description: string;
    latestMessageId?: string;
    isGrouped?: boolean;
    senderDetails?: SenderInfo[];
    metrics?: {
        primary: number;
        promotions: number;
        social: number;
        updates: number;
    };
}

export class GmailClient {
    private gmail: gmail_v1.Gmail;

    constructor(accessToken: string) {
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: accessToken });
        this.gmail = google.gmail({ version: "v1", auth });
    }

    async getProfile(): Promise<gmail_v1.Schema$Profile> {
        const response = await this.gmail.users.getProfile({ userId: "me" });
        return response.data;
    }

    async getLabels(): Promise<gmail_v1.Schema$Label[]> {
        const response = await this.gmail.users.labels.list({ userId: "me" });
        return response.data.labels || [];
    }

    async createLabel(name: string): Promise<gmail_v1.Schema$Label> {
        const response = await this.gmail.users.labels.create({
            userId: "me",
            requestBody: {
                name,
                labelListVisibility: "labelShow",
                messageListVisibility: "show",
            },
        });
        return response.data;
    }

    async getMessages(
        maxResults: number = 100,
        pageToken?: string,
        query: string = "in:inbox",
        onProgress?: (batchMessages: EmailMessage[], totalFetched: number) => void
    ): Promise<{ messages: EmailMessage[]; nextPageToken?: string }> {
        const response = await this.gmail.users.messages.list({
            userId: "me",
            maxResults,
            pageToken,
            q: query,
        });

        if (!response.data.messages) {
            return { messages: [] };
        }

        // Fetch messages in batches to avoid rate limits
        // Increased to 25 based on user feedback (balancing speed vs rate limits)
        const BATCH_SIZE = 25;
        const messages: EmailMessage[] = [];
        const msgIds = response.data.messages.map(m => m.id!);

        for (let i = 0; i < msgIds.length; i += BATCH_SIZE) {
            const batch = msgIds.slice(i, i + BATCH_SIZE);

            // Add a delay between batches to respect rate limits
            // Reduced to 400ms to allow faster scanning (approx 60-70% quota usage)
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, 400));
            }

            const batchResults = await Promise.all(
                batch.map(id => this.getMessage(id))
            );
            const validMessages = batchResults.filter((m): m is EmailMessage => m !== null);
            messages.push(...validMessages);

            if (onProgress) {
                onProgress(validMessages, messages.length);
            }
        }

        return {
            messages, // We still return all messages for compatibility, though caller might use onProgress
            nextPageToken: response.data.nextPageToken || undefined,
        };
    }

    /**
     * Efficiently counts messages for a query without downloading body content.
     * Used for accurately verifying sender volume without quota-heavy detail fetches.
     */
    async getMessageCount(query: string, maxResults: number = 500): Promise<{ count: number, nextPageToken?: string }> {
        // We use 'maxResults + 1' to detect if there are more
        const response = await this.gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: maxResults,
            includeSpamTrash: false
        });

        const messages = response.data.messages || [];
        return {
            count: messages.length,
            nextPageToken: response.data.nextPageToken || undefined
        };
    }

    async getMessage(id: string): Promise<EmailMessage | null> {
        try {
            const response = await this.gmail.users.messages.get({
                userId: "me",
                id,
                format: "metadata",
                metadataHeaders: ["From", "Subject", "Date"],
            });

            const headers = response.data.payload?.headers || [];
            const getHeader = (name: string) =>
                headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
                    ?.value || "";

            const from = getHeader("From");
            const fromMatch = from.match(/<(.+?)>/) || [null, from];
            const fromEmail = fromMatch[1] || from;
            const fromDomain = fromEmail.split("@")[1] || "";

            return {
                id: response.data.id!,
                threadId: response.data.threadId!,
                snippet: response.data.snippet || "",
                subject: getHeader("Subject"),
                from,
                fromEmail,
                fromDomain,
                date: new Date(getHeader("Date")),
                labelIds: response.data.labelIds || [],
                isUnread: response.data.labelIds?.includes("UNREAD") || false,
            };
        } catch (error) {
            console.error(`Failed to get message ${id}:`, error);
            return null;
        }
    }

    async archiveMessages(messageIds: string[]): Promise<void> {
        await this.gmail.users.messages.batchModify({
            userId: "me",
            requestBody: {
                ids: messageIds,
                removeLabelIds: ["INBOX"],
            },
        });
    }

    async applyLabel(messageIds: string[], labelId: string): Promise<void> {
        await this.gmail.users.messages.batchModify({
            userId: "me",
            requestBody: {
                ids: messageIds,
                addLabelIds: [labelId],
            },
        });
    }

    async createFilter(
        criteria: gmail_v1.Schema$FilterCriteria,
        action: gmail_v1.Schema$FilterAction
    ): Promise<gmail_v1.Schema$Filter> {
        const response = await this.gmail.users.settings.filters.create({
            userId: "me",
            requestBody: {
                criteria,
                action,
            },
        });
        return response.data;
    }

    async getFilters(): Promise<gmail_v1.Schema$Filter[]> {
        const response = await this.gmail.users.settings.filters.list({
            userId: "me",
        });
        return response.data.filter || [];
    }

    // Fast estimate using resultSizeEstimate (not exact but much faster)
    async getMessageCountEstimate(query: string): Promise<number> {
        const res = await this.gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: 1,
        });
        return res.data.resultSizeEstimate || 0;
    }

    async getThreadCount(query: string): Promise<number> {
        let count = 0;
        let pageToken: string | undefined = undefined;

        while (true) {
            const listParams: { userId: string; q: string; maxResults: number; pageToken?: string } = {
                userId: "me",
                q: query,
                maxResults: 500,
            };
            if (pageToken) listParams.pageToken = pageToken;

            const res = await this.gmail.users.threads.list(listParams);
            count += res.data.threads?.length || 0;
            pageToken = res.data.nextPageToken || undefined;
            if (!pageToken) break;
        }

        return count;
    }

    async getInboxStats(): Promise<{
        total: number;
        unread: number;
        isExact: boolean;
        hasCategoryTabs: boolean;
        categories: {
            primary: number;
            promotions: number;
            social: number;
            updates: number;
        };
    }> {
        // First check if user has category tabs enabled by testing category:primary
        const primaryTest = await this.gmail.users.threads.list({
            userId: "me",
            q: "in:inbox category:primary",
            maxResults: 1,
        });

        const hasCategoryTabs = (primaryTest.data.resultSizeEstimate || 0) > 0;

        // Use category:primary if tabs are enabled (to match Gmail UI), otherwise use in:inbox
        const baseQuery = hasCategoryTabs ? "in:inbox category:primary" : "in:inbox";
        const unreadQuery = hasCategoryTabs ? "in:inbox category:primary is:unread" : "in:inbox is:unread";

        console.log("Category tabs enabled:", hasCategoryTabs, "Using query:", baseQuery);

        // Get estimate using threads API
        // We also want breakdown by category for the dashboard
        const queries = {
            total: baseQuery,
            unread: unreadQuery,
            primary: "in:inbox category:primary",
            promotions: "in:inbox category:promotions",
            social: "in:inbox category:social",
            updates: "in:inbox category:updates"
        };

        const promises = Object.entries(queries).map(async ([key, q]) => {
            const response = await this.gmail.users.messages.list({ // Use messages for more accurate "cleaning" stats
                userId: "me",
                q,
                maxResults: 1,
            });
            const est = response.data.resultSizeEstimate || 0;
            // If small, get exact
            if (est < 500) {
                const exact = await this.getMessageCount(q, 500);
                return { key, count: exact.count };
            }
            return { key, count: est };
        });

        const results = await Promise.all(promises);
        const stats = results.reduce((acc, curr) => {
            acc[curr.key] = curr.count;
            return acc;
        }, {} as Record<string, number>);

        return {
            total: stats.total,
            unread: stats.unread,
            categories: {
                primary: stats.primary,
                promotions: stats.promotions,
                social: stats.social,
                updates: stats.updates
            },
            isExact: false, // We use estimates mostly
            hasCategoryTabs,
        };
    }
}

// Extract the root domain from an email domain (e.g., notifications4.creditkarma.com -> creditkarma.com)
function getRootDomain(domain: string): string {
    const parts = domain.toLowerCase().split(".");

    // Handle special cases like co.uk, com.au, etc.
    const specialTLDs = ["co.uk", "com.au", "co.nz", "co.jp", "com.br", "co.in"];

    if (parts.length >= 3) {
        const lastTwo = parts.slice(-2).join(".");
        if (specialTLDs.includes(lastTwo)) {
            // Return last 3 parts for special TLDs (e.g., example.co.uk)
            return parts.slice(-3).join(".");
        }
    }

    // Return last 2 parts (e.g., creditkarma.com from notifications4.creditkarma.com)
    if (parts.length >= 2) {
        return parts.slice(-2).join(".");
    }

    return domain;
}

export function clusterByDomain(messages: EmailMessage[]): EmailCluster[] {
    // First, separate automated emails from personal emails
    const automatedMessages: EmailMessage[] = [];
    const personalMessages: EmailMessage[] = [];

    for (const msg of messages) {
        if (isLikelyAutomated(msg.fromEmail, msg.fromDomain)) {
            automatedMessages.push(msg);
        } else {
            personalMessages.push(msg);
        }
    }

    const clusters: EmailCluster[] = [];

    // 1. First, group by FULL domain (e.g. mail.google.com, docs.google.com)
    const fullDomainMap = new Map<string, EmailMessage[]>();
    for (const msg of automatedMessages) {
        const existing = fullDomainMap.get(msg.fromDomain) || [];
        existing.push(msg);
        fullDomainMap.set(msg.fromDomain, existing);
    }

    // 2. Identify Root Domains that have MULTIPLE Full Domains
    const rootDomainGroups = new Map<string, string[]>(); // root -> [full1, full2]

    for (const fullDomain of fullDomainMap.keys()) {
        const root = getRootDomain(fullDomain);
        const existing = rootDomainGroups.get(root) || [];
        existing.push(fullDomain);
        rootDomainGroups.set(root, existing);
    }

    // 3. Create clusters
    // If a root domain has multiple full domains (e.g. creditkarma), group them
    // Otherwise, keep them as separate full domains (e.g. google.com)

    const processedFullDomains = new Set<string>();

    for (const [root, fullDomains] of rootDomainGroups) {
        // Only group if we have 2+ DISTINCT full domains (e.g. mail.x.com AND alerts.x.com)
        // OR if there are many different senders (5+) on the same domain (e.g. 20 diff newsletters from nytimes.com)

        let shouldGroup = false;

        if (fullDomains.length > 1) {
            shouldGroup = true;
        } else {
            // Single full domain - check if we have many different senders
            const msgs = fullDomainMap.get(fullDomains[0])!;
            const uniqueSenders = new Set(msgs.map(m => m.fromEmail)).size;
            if (uniqueSenders >= 5) {
                shouldGroup = true;
            }
        }

        if (shouldGroup) {
            // Merge all messages for this root domain
            const mergedMsgs: EmailMessage[] = [];
            for (const fd of fullDomains) {
                mergedMsgs.push(...fullDomainMap.get(fd)!);
                processedFullDomains.add(fd);
            }

            // Create grouped cluster logic...
            processCluster(mergedMsgs, root, true);
        }
    }

    // Process remaining full domains that weren't grouped
    for (const [fullDomain, msgs] of fullDomainMap) {
        if (!processedFullDomains.has(fullDomain)) {
            processCluster(msgs, fullDomain, false);
        }
    }

    function processCluster(msgs: EmailMessage[], domainKey: string, isRootGroup: boolean) {
        // Collect all unique senders with counts and calculate category metrics
        const senderCounts = new Map<string, number>();
        const metrics = {
            primary: 0,
            promotions: 0,
            social: 0,
            updates: 0
        };

        for (const msg of msgs) {
            senderCounts.set(msg.fromEmail, (senderCounts.get(msg.fromEmail) || 0) + 1);

            // Check label IDs for categories
            if (!msg.labelIds) continue;

            if (msg.labelIds.includes("CATEGORY_PERSONAL")) metrics.primary++;
            else if (msg.labelIds.includes("CATEGORY_PROMOTIONS")) metrics.promotions++;
            else if (msg.labelIds.includes("CATEGORY_SOCIAL")) metrics.social++;
            else if (msg.labelIds.includes("CATEGORY_UPDATES")) metrics.updates++;
            // If no category label but in INBOX, it's often effectively Primary
            else if (msg.labelIds.includes("INBOX")) metrics.primary++;
        }

        const allSenders = Array.from(senderCounts.keys());
        const isGrouped = allSenders.length > 1; // It's grouped if > 1 sender, regardless of domain logic

        // Generate sender details with AI recommendations
        const senderDetails: SenderInfo[] = Array.from(senderCounts.entries())
            .map(([email, count]) => {
                const important = isLikelyImportant(email);
                return {
                    email,
                    count,
                    shouldArchive: !important,
                    reason: important
                        ? "⚠️ May contain important account info"
                        : "📧 Looks like automated/marketing",
                };
            })
            .sort((a, b) => b.count - a.count);

        const primarySender = senderDetails[0]?.email || msgs[0].fromEmail;

        // Logic for wildcards:
        // If isRootGroup (multiple subdomains), use `*@*.root.com`
        // If single domain but multiple senders, use `*@domain.com`
        // If single sender, use specific email

        let displaySender = primarySender;
        if (isGrouped) {
            if (isRootGroup) {
                displaySender = `*@*.${domainKey}`;
            } else {
                displaySender = `*@${domainKey}`;
            }
        }

        let suggestedAction: EmailCluster["suggestedAction"] = "filter";
        let suggestedLabel: string | undefined;

        if (msgs.length < 5) { // Lower threshold for individual groups
            suggestedAction = "archive"; // Default to archive but maybe not filter
        }
        if (msgs.length >= 10) {
            suggestedAction = "filter";
        }

        clusters.push({
            domain: domainKey,
            sender: displaySender,
            count: msgs.length,
            messages: msgs,
            suggestedAction,
            suggestedLabel,
            allSenders,
            isGrouped,
            senderDetails,
            metrics
        });
    }

    // Group PERSONAL emails by exact sender (don't merge - these could be important)
    const senderMap = new Map<string, EmailMessage[]>();
    for (const msg of personalMessages) {
        const existing = senderMap.get(msg.fromEmail) || [];
        existing.push(msg);
        senderMap.set(msg.fromEmail, existing);
    }

    for (const [sender, msgs] of senderMap) {
        let suggestedAction: EmailCluster["suggestedAction"] = "keep"; // Personal = default keep

        // Only suggest actions for high volume personal senders
        if (msgs.length >= 20) {
            suggestedAction = "filter";
        } else if (msgs.length >= 10) {
            suggestedAction = "label";
        }

        // Calculate metrics for personal cluster
        const metrics = {
            primary: 0,
            promotions: 0,
            social: 0,
            updates: 0
        };

        for (const msg of msgs) {
            if (!msg.labelIds) continue;
            if (msg.labelIds.includes("CATEGORY_PERSONAL")) metrics.primary++;
            else if (msg.labelIds.includes("CATEGORY_PROMOTIONS")) metrics.promotions++;
            else if (msg.labelIds.includes("CATEGORY_SOCIAL")) metrics.social++;
            else if (msg.labelIds.includes("CATEGORY_UPDATES")) metrics.updates++;
            else if (msg.labelIds.includes("INBOX")) metrics.primary++;
        }

        // Generate simple senderDetails for personal cluster
        const senderDetails: SenderInfo[] = [{
            email: sender,
            count: msgs.length,
            shouldArchive: false,
            reason: "👤 Looks like a personal sender"
        }];

        clusters.push({
            domain: msgs[0].fromDomain,
            sender,
            count: msgs.length,
            messages: msgs,
            suggestedAction,
            suggestedLabel: undefined,
            isGrouped: false,
            senderDetails,
            metrics
        });
    }

    // Sort by count descending
    return clusters.sort((a, b) => b.count - a.count);
}

function isLikelyAutomated(sender: string, domain: string): boolean {
    const automatedPatterns = [
        /noreply/i,
        /no-reply/i,
        /donotreply/i,
        /notifications?/i,
        /alerts?/i,
        /updates?/i,
        /newsletter/i,
        /marketing/i,
        /promo/i,
    ];

    return automatedPatterns.some(
        (pattern) => pattern.test(sender) || pattern.test(domain)
    );
}

// Detect senders that are likely important and should NOT be auto-archived
export function isLikelyImportant(sender: string): boolean {
    const importantPatterns = [
        /security/i,
        /account/i,
        /support/i,
        /help/i,
        /service/i,
        /confirm/i,
        /verify/i,
        /password/i,
        /reset/i,
        /auth/i,
        /login/i,
        /order/i,
        /receipt/i,
        /payment/i,
        /billing/i,
        /invoice/i,
        /transaction/i,
        /shipping/i,
        /delivery/i,
    ];

    return importantPatterns.some((pattern) => pattern.test(sender));
}

export function generateFilterSuggestions(
    clusters: EmailCluster[]
): FilterSuggestion[] {
    const suggestions: FilterSuggestion[] = [];

    for (const cluster of clusters) {
        if (cluster.suggestedAction === "filter" && cluster.count >= 5) {
            // Get the most recent message (messages are typically sorted by date)
            const latestMessage = cluster.messages.sort((a, b) =>
                new Date(b.date).getTime() - new Date(a.date).getTime()
            )[0];

            // detailed logic to determine safety
            const hasImportantSender = cluster.senderDetails?.some(s => !s.shouldArchive) ?? false;
            const hasSpamSender = cluster.senderDetails?.some(s => s.shouldArchive) ?? false;
            const isMixed = hasImportantSender && hasSpamSender;

            // If it's a mixed group (some good, some bad), we should NOT suggest a wildcard.
            // Instead, we should split it and suggest filters for ALL of them individually.
            // This allows the user to decide if they want to filter the "Important" ones too.
            if (cluster.isGrouped && isMixed && cluster.senderDetails) {
                // We intentionally process ALL senders, not just the "bad" ones.
                for (const sender of cluster.senderDetails) {
                    if (sender.count < 5) continue; // Skip insignificant sub-senders

                    suggestions.push({
                        id: `filter-${sender.email}`,
                        criteria: { from: sender.email },
                        action: { skipInbox: true, addLabel: cluster.suggestedLabel },
                        matchCount: sender.count,
                        description: `Auto-archive emails from ${sender.email} (${sender.count} messages)`,
                        isGrouped: false,
                        senderDetails: [sender],
                        metrics: cluster.metrics // Approximation, sharing metrics
                    });
                }
                continue; // Done with this cluster
            }

            // Otherwise (All Good or All Bad), proceed with standard logic
            // For grouped domains (All Bad), use wildcard pattern
            const filterFrom = cluster.isGrouped
                ? `*${cluster.domain}`
                : cluster.sender;

            const action = {
                // We default to skipping inbox for everything
                // The UI will show a warning if it's risky (All Safe group)
                skipInbox: true,
                addLabel: cluster.suggestedLabel,
            };

            const actionVerb = "Auto-archive"; // Always auto-archive since that's the default action now

            const senderCount = cluster.allSenders?.length || 1;
            const description = cluster.isGrouped
                ? `${actionVerb} emails from ${senderCount} senders at ${cluster.domain} (${cluster.count} messages)`
                : `${actionVerb} emails from ${cluster.sender} (${cluster.count} messages)`;

            suggestions.push({
                id: `filter-${cluster.domain}`,
                criteria: {
                    from: filterFrom,
                },
                action,
                matchCount: cluster.count,
                description,
                latestMessageId: cluster.messages[0]?.id,
                isGrouped: cluster.isGrouped,
                senderDetails: cluster.senderDetails,
                metrics: cluster.metrics,
            });
        }
    }

    return suggestions;
}
