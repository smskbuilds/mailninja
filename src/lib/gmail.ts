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

export interface EmailCluster {
    domain: string;
    sender: string;
    count: number;
    messages: EmailMessage[];
    suggestedAction: "archive" | "label" | "keep" | "filter";
    suggestedLabel?: string;
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
        query: string = "in:inbox"
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

        const messages = await Promise.all(
            response.data.messages.map((msg) => this.getMessage(msg.id!))
        );

        return {
            messages: messages.filter((m): m is EmailMessage => m !== null),
            nextPageToken: response.data.nextPageToken || undefined,
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

    async getMessageCount(query: string): Promise<number> {
        let count = 0;
        let pageToken: string | undefined = undefined;

        while (true) {
            const listParams: { userId: string; q: string; maxResults: number; pageToken?: string } = {
                userId: "me",
                q: query,
                maxResults: 500,
            };
            if (pageToken) listParams.pageToken = pageToken;

            const res = await this.gmail.users.messages.list(listParams);
            count += res.data.messages?.length || 0;
            pageToken = res.data.nextPageToken || undefined;
            if (!pageToken) break;
        }

        return count;
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

        // Get estimate using threads API (Gmail UI shows thread count, not message count)
        const [totalResponse, unreadResponse] = await Promise.all([
            this.gmail.users.threads.list({
                userId: "me",
                q: baseQuery,
                maxResults: 1,
            }),
            this.gmail.users.threads.list({
                userId: "me",
                q: unreadQuery,
                maxResults: 1,
            }),
        ]);

        const estimate = totalResponse.data.resultSizeEstimate || 0;
        const unreadEstimate = unreadResponse.data.resultSizeEstimate || 0;

        // If estimate is under 500, get exact thread count
        if (estimate < 500) {
            const total = await this.getThreadCount(baseQuery);
            const unread = await this.getThreadCount(unreadQuery);
            return { total, unread, isExact: true, hasCategoryTabs };
        }

        return {
            total: estimate,
            unread: unreadEstimate,
            isExact: false,
            hasCategoryTabs,
        };
    }
}

export function clusterByDomain(messages: EmailMessage[]): EmailCluster[] {
    const domainMap = new Map<string, EmailMessage[]>();

    for (const msg of messages) {
        const existing = domainMap.get(msg.fromDomain) || [];
        existing.push(msg);
        domainMap.set(msg.fromDomain, existing);
    }

    const clusters: EmailCluster[] = [];

    for (const [domain, msgs] of domainMap) {
        // Group by sender within domain
        const senderMap = new Map<string, EmailMessage[]>();
        for (const msg of msgs) {
            const existing = senderMap.get(msg.fromEmail) || [];
            existing.push(msg);
            senderMap.set(msg.fromEmail, existing);
        }

        for (const [sender, senderMsgs] of senderMap) {
            let suggestedAction: EmailCluster["suggestedAction"] = "keep";
            let suggestedLabel: string | undefined;

            // Suggest actions based on patterns
            if (senderMsgs.length >= 10) {
                // High volume sender - suggest filter
                suggestedAction = "filter";
            } else if (senderMsgs.length >= 5) {
                // Medium volume - suggest labeling
                suggestedAction = "label";
                suggestedLabel = domain.split(".")[0];
            } else if (isLikelyAutomated(sender, domain)) {
                suggestedAction = "archive";
            }

            clusters.push({
                domain,
                sender,
                count: senderMsgs.length,
                messages: senderMsgs,
                suggestedAction,
                suggestedLabel,
            });
        }
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

            suggestions.push({
                id: `filter-${cluster.sender}`,
                criteria: {
                    from: cluster.sender,
                },
                action: {
                    skipInbox: true,
                    addLabel: cluster.suggestedLabel,
                },
                matchCount: cluster.count,
                description: `Auto-archive emails from ${cluster.sender} (${cluster.count} messages)`,
                latestMessageId: latestMessage?.id,
            });
        }
    }

    return suggestions;
}
