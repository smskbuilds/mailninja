"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import styles from "./page.module.css";

interface EmailCluster {
    domain: string;
    sender: string;
    count: number;
    countDisplay?: string;
    suggestedAction: "archive" | "label" | "keep" | "filter";
    suggestedLabel?: string;
    messageIds: string[];
}

interface SenderInfo {
    email: string;
    count: number;
    shouldArchive: boolean;
    reason: string;
}

interface FilterSuggestion {
    id: string;
    criteria: {
        from?: string;
    };
    action: {
        skipInbox?: boolean;
        addLabel?: string;
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

const categoryLabels: Record<string, string> = {
    primary: "Primary",
    updates: "Updates",
    promotions: "Promotions",
    social: "Social"
};

interface InboxStats {
    total: number;
    unread: number;
    isExact: boolean;
    clusters: number;
    filterSuggestions: number;
    categories?: {
        primary: number;
        promotions: number;
        social: number;
        updates: number;
    };
}

interface ExistingFilter {
    id: string;
    from: string;
    inboxCount: number;
    inboxCountDisplay: string;
}

interface GmailLabel {
    id: string;
    name: string;
}

interface AnalysisResult {
    stats: InboxStats;
    clusters: EmailCluster[];
    filterSuggestions: FilterSuggestion[];
    existingFilters: ExistingFilter[];
}

export default function Dashboard() {
    const { data: session, status } = useSession();
    const router = useRouter();

    const [isLoading, setIsLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
    const [loadingStage, setLoadingStage] = useState<string>("Connecting to Gmail...");
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingMessage, setProcessingMessage] = useState<string>("");
    const [reviewModalOpen, setReviewModalOpen] = useState(false);
    const [loadingStep, setLoadingStep] = useState(0);
    const [selectedSuggestion, setSelectedSuggestion] = useState<FilterSuggestion | null>(null);
    const [excludedSenders, setExcludedSenders] = useState<Set<string>>(new Set());

    // Label modal state
    const [labelModalOpen, setLabelModalOpen] = useState(false);
    const [labelModalSuggestion, setLabelModalSuggestion] = useState<FilterSuggestion | null>(null);
    const [availableLabels, setAvailableLabels] = useState<GmailLabel[]>([]);
    const [selectedLabelName, setSelectedLabelName] = useState("");
    const [newLabelName, setNewLabelName] = useState("");
    const [skipInboxChecked, setSkipInboxChecked] = useState(true);

    const showToast = (message: string, type: "success" | "error") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    };

    const abortControllerRef = useRef<AbortController | null>(null);

    const fetchAnalysis = useCallback(async (isBackground = false) => {
        if (!session?.accessToken) return;

        // Abort previous request if active
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;

        setLoadingStage("Connecting to Gmail...");
        setLoadingStep(0);

        // If not background, show full loading modal
        if (!isBackground) {
            setIsLoading(true);
        } else {
            // If background, show header spinner
            setIsRefreshing(true);
        }

        try {
            const response = await fetch("/api/gmail/analyze", {
                signal: controller.signal
            });
            if (!response.ok) throw new Error("Failed to analyze inbox");

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No reader available");

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");

                // Keep the last line in the buffer as it might be incomplete
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const message = JSON.parse(line);

                        if (message.type === "progress") {
                            setLoadingStage(message.stage);
                            const msg = message.stage.toLowerCase();

                            if (msg.includes("connecting")) setLoadingStep(0);
                            else if (msg.includes("stats") || msg.includes("priority")) setLoadingStep(1);
                            else if (msg.includes("fetching") || msg.includes("scanning")) setLoadingStep(2);
                            else if (msg.includes("filter") || msg.includes("clustering")) setLoadingStep(3);
                            else if (msg.includes("count")) setLoadingStep(4);
                        } else if (message.type === "result") {
                            console.log("Received result data:", message.data);
                            setAnalysis(message.data);
                        } else if (message.type === "error") {
                            throw new Error(message.message);
                        }
                    } catch (e) {
                        console.error("Stream parse error:", e);
                    }
                }
            }

            // Flush decoder
            buffer += decoder.decode();

            // Process any remaining buffer
            if (buffer.trim()) {
                try {
                    const message = JSON.parse(buffer);
                    if (message.type === "result") {
                        console.log("Received result data (buffered):", message.data);
                        setAnalysis(message.data);
                    }
                } catch (e) {
                    console.error("Final buffer parse error:", e);
                }
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log("Analysis aborted");
                return;
            }
            console.error("Analysis error:", error);
            showToast("Failed to analyze inbox: " + (error.message || String(error)), "error");
        } finally {
            // Only turn off loading if this is still the active controller
            if (abortControllerRef.current === controller) {
                setIsLoading(false);
                setIsRefreshing(false);
                abortControllerRef.current = null;
            }
        }
    }, [session?.accessToken]);

    useEffect(() => {
        if (status === "unauthenticated") {
            router.push("/");
        }
    }, [status, router]);

    useEffect(() => {
        if (session?.accessToken) {
            fetchAnalysis();
        }
    }, [session?.accessToken, fetchAnalysis]);

    const handleRefresh = () => {
        setIsRefreshing(true);
        setIsLoading(true); // Show full loading modal with progress
        setLoadingStage("Connecting to Gmail...");
        fetchAnalysis();
    };

    const handleArchive = async (cluster: EmailCluster) => {
        try {
            const response = await fetch("/api/gmail/actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "archive",
                    messageIds: cluster.messageIds,
                }),
            });

            if (!response.ok) throw new Error("Failed to archive");

            showToast(`Archived ${cluster.count} emails from ${cluster.sender}`, "success");

            // Remove cluster from list
            if (analysis) {
                setAnalysis({
                    ...analysis,
                    clusters: analysis.clusters.filter(c => c.sender !== cluster.sender),
                    stats: {
                        ...analysis.stats,
                        total: analysis.stats.total - cluster.count,
                    },
                });
            }
        } catch (error) {
            console.error("Archive error:", error);
            showToast("Failed to archive emails", "error");
        }
    };

    const handleCreateFilter = async (suggestion: FilterSuggestion) => {
        // If grouped suggestion, open review modal first
        if (suggestion.isGrouped && suggestion.senderDetails) {
            setSelectedSuggestion(suggestion);

            // Auto-exclude important senders by default
            const toExclude = new Set<string>();
            suggestion.senderDetails.forEach(s => {
                if (!s.shouldArchive) {
                    toExclude.add(s.email);
                }
            });
            setExcludedSenders(toExclude);
            setReviewModalOpen(true);
            return;
        }

        // Otherwise proceed with creation
        await createFilter(suggestion);
    };

    const [trustedSenders, setTrustedSenders] = useState<string[]>([]);

    useEffect(() => {
        if (session?.accessToken) {
            // TODO: Re-enable when using Vercel KV or database storage
            // Trusted senders disabled for serverless deployment
            // fetch("/api/settings/trusted")
            //     .then(res => res.json())
            //     .then(data => {
            //         if (data.senders) setTrustedSenders(data.senders);
            //     })
            //     .catch(err => console.error("Failed to fetch trusted senders", err));

            // Fetch available labels
            fetch("/api/gmail/labels")
                .then(res => res.json())
                .then(data => {
                    if (data.labels) setAvailableLabels(data.labels);
                })
                .catch(err => console.error("Failed to fetch labels", err));
        }
    }, [session?.accessToken]);

    const handleOpenLabelModal = (suggestion: FilterSuggestion) => {
        setLabelModalSuggestion(suggestion);
        setSelectedLabelName("");
        setNewLabelName("");
        setSkipInboxChecked(true);
        setLabelModalOpen(true);
    };

    const handleConfirmLabelAction = async () => {
        if (!labelModalSuggestion) return;

        const labelName = selectedLabelName === "__new__" ? newLabelName : selectedLabelName;

        if (!labelName) {
            showToast("Please select or enter a label name", "error");
            return;
        }

        setLabelModalOpen(false);

        await processStreamedAction({
            action: "labelAndFilter",
            criteria: labelModalSuggestion.criteria,
            labelName: labelName,
            skipInbox: skipInboxChecked,
        }, (result) => {
            const labeledCount = result.labeledCount || 0;
            showToast(
                `Created filter and labeled ${labeledCount} emails with "${labelName}"` +
                (skipInboxChecked ? " (archived)" : ""),
                "success"
            );

            // Remove suggestion from list
            if (analysis) {
                setAnalysis({
                    ...analysis,
                    filterSuggestions: analysis.filterSuggestions.filter(
                        s => s.id !== labelModalSuggestion.id
                    ),
                });
            }

            // Add new label to available list if it was new
            if (selectedLabelName === "__new__" && newLabelName) {
                setAvailableLabels(prev => [...prev, { id: "new", name: newLabelName }]);
            }
        });

        setLabelModalSuggestion(null);
    };

    const handleConfirmFilter = async () => {
        if (!selectedSuggestion) return;
        setReviewModalOpen(false);

        // Save excluded senders as Trusted
        if (excludedSenders.size > 0) {
            try {
                const emailsToTrust = Array.from(excludedSenders);
                await fetch("/api/settings/trusted", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ emails: emailsToTrust })
                });
                // Update local state
                setTrustedSenders(prev => [...prev, ...emailsToTrust]);
            } catch (error) {
                console.error("Failed to save trusted senders", error);
            }
        }

        // If we have excluded senders, we need to modify the criteria
        let criteria = { ...selectedSuggestion.criteria };
        if (excludedSenders.size > 0) {
            // Gmail query for: (original_query) -from:(excluded1) -from:(excluded2)
            const exclusions = Array.from(excludedSenders)
                .map(email => `-from:${email}`)
                .join(" ");

            // If original criteria uses 'from', combine it
            if (criteria.from) {
                // Should look like: from:(*@domain.com) -from:exclude1@domain.com
                criteria.from = `(${criteria.from}) ${exclusions}`;
            }
        }

        // Create modified suggestion with updated criteria
        const modifiedSuggestion = {
            ...selectedSuggestion,
            criteria
        };

        await createFilter(modifiedSuggestion);
        setSelectedSuggestion(null);
    };

    // Generic handler for streaming actions
    const processStreamedAction = async (payload: any, onSuccess: (result: any) => void) => {
        setIsProcessing(true);
        setProcessingMessage("Initializing action...");

        try {
            const response = await fetch("/api/gmail/actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!response.ok) throw new Error("Failed to execute action");

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const msg = JSON.parse(line);

                        if (msg.type === "progress") {
                            setProcessingMessage(msg.stage);
                        } else if (msg.type === "result") {
                            onSuccess(msg.data);
                        } else if (msg.type === "error") {
                            throw new Error(msg.error);
                        }
                    } catch (e) {
                        console.error("Error parsing stream line", e);
                    }
                }
            }
        } catch (error) {
            console.error("Action error:", error);
            showToast("Action failed: " + (error instanceof Error ? error.message : "Unknown error"), "error");
        } finally {
            setIsProcessing(false);
            setProcessingMessage("");
        }
    };

    const createFilter = async (suggestion: FilterSuggestion) => {
        await processStreamedAction({
            action: "createFilter",
            criteria: suggestion.criteria,
            filterAction: suggestion.action,
            archiveExisting: true,
        }, (result) => {
            const archivedCount = result.archivedCount || 0;
            showToast(
                `Filter created successfully` +
                (archivedCount > 0 ? ` and archived ${archivedCount} emails` : ""),
                "success"
            );

            // Remove suggestion from list
            if (analysis) {
                setAnalysis({
                    ...analysis,
                    filterSuggestions: analysis.filterSuggestions.filter(s => s.id !== suggestion.id),
                });
            }
        });
    };

    const handleArchiveOnly = async (suggestion: FilterSuggestion) => {
        // Optimistic update: Remove suggestion immediately
        handleDismissSuggestion(suggestion.id);

        const sender = suggestion.criteria.from || "";
        if (!sender) {
            console.error("handleArchiveOnly: No sender found for suggestion", suggestion);
            return;
        }

        await processStreamedAction({
            action: "archiveFromSender",
            sender: sender,
        }, (result) => {
            const archivedCount = result.archivedCount || 0;
            showToast(`Archived ${archivedCount} emails from ${sender}`, "success");

            // Refresh analysis to update counts
            // We can't just remove the suggestion because the filter wasn't created, 
            // but the emails are gone, so the suggestion might no longer be valid.
            // Best to just refresh.
            fetchAnalysis(true);
        });
    };

    const handleDismissSuggestion = (suggestionId: string) => {
        if (analysis) {
            setAnalysis({
                ...analysis,
                filterSuggestions: analysis.filterSuggestions.filter(s => s.id !== suggestionId),
            });
        }
    };

    const handleArchiveFromFilter = async (filter: ExistingFilter) => {
        try {
            const response = await fetch("/api/gmail/actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "archiveFromSender",
                    sender: filter.from,
                }),
            });

            if (!response.ok) throw new Error("Failed to archive");

            const result = await response.json();
            showToast(`Archived ${result.archivedCount} emails from ${filter.from}`, "success");

            // Refresh to update counts (Silent)
            fetchAnalysis(true);
        } catch (error) {
            console.error("Archive error:", error);
            showToast("Failed to archive emails", "error");
        }
    };

    if (status === "loading" || isLoading) {
        return (
            <div className={styles.dashboard}>
                <header className={styles.header}>
                    <div className={styles.logo}>
                        <span className={styles.logoIcon}>🥷</span>
                        <span className={styles.logoGradient}>MailNinja</span>
                    </div>
                </header>
                <div className={styles.loadingContainer}>
                    {/* Visual Progress Bar */}
                    {(() => {
                        // Parse the progress string: "Scanning primary (Scanned 1200 | Collected 800/1000 limit)"
                        // Regex now handles "Found" OR "Collected", and optional " limit" suffix
                        const match = loadingStage.match(/Scanning (.*) \(Scanned (\d+) \| (?:Found|Collected) (\d+)\/(\d+)(?: limit)?\)/);

                        if (match) {
                            const [_, category, scanned, found, target] = match;
                            const progress = Math.min((parseInt(found) / parseInt(target)) * 100, 100);

                            return (
                                <div className={styles.progressContainer}>
                                    <h2 className={styles.loadingTitle}>Analyzing Inbox</h2>
                                    <p className={styles.loadingSubtitle}>
                                        We're scanning your recent emails to find senders and patterns.
                                    </p>

                                    <div className={styles.progressBarBg}>
                                        <div
                                            className={styles.progressBarFill}
                                            style={{ width: `${progress}%` }}
                                        />
                                    </div>

                                    <div className={styles.progressStats}>
                                        <div className={styles.statItem}>
                                            <span className={styles.statLabel}>Current Folder</span>
                                            <span className={styles.statValue}>{category}</span>
                                        </div>
                                        <div className={styles.statItem}>
                                            <span className={styles.statLabel}>Emails Checked</span>
                                            <span className={styles.statValue}>{parseInt(scanned).toLocaleString()}</span>
                                        </div>
                                        <div className={styles.statItem}>
                                            <span className={styles.statLabel}>Collected</span>
                                            <span className={styles.statValue}>{parseInt(found).toLocaleString()} / {target}</span>
                                        </div>
                                    </div>
                                </div>
                            );
                        }

                        // Specific UI for "Accurate Counts" step
                        if (loadingStep === 4) {
                            return (
                                <>
                                    <div className="spinner" />
                                    <h2 className={styles.loadingTitle}>Verifying Top Senders</h2>
                                    <p className={styles.loadingSubtitle}>
                                        We're double-checking the exact email counts for your biggest clutter sources to ensure our clean-up estimates are 100% accurate.
                                    </p>
                                </>
                            );
                        }

                        // Fallback for other stages (Connecting, Clustering, etc.)
                        return (
                            <>
                                <div className="spinner" />
                                <h2 className={styles.loadingTitle}>Analyzing Your Inbox</h2>
                                <p className={styles.loadingStage}>{loadingStage}</p>
                            </>
                        );
                    })()}

                    <div className={styles.loadingSteps}>
                        <p className={styles.loadingStep}>
                            {loadingStep === 0 ? "⏳" : loadingStep > 0 ? "✅" : "⏸️"} Connecting to Gmail
                        </p>
                        <p className={styles.loadingStep}>
                            {loadingStep === 1 ? "⏳" : loadingStep > 1 ? "✅" : "⏸️"} Getting inbox stats
                        </p>
                        <p className={styles.loadingStep}>
                            {loadingStep === 2 ? "⏳" : loadingStep > 2 ? "✅" : "⏸️"} Fetching recent emails
                        </p>
                        <p className={styles.loadingStep}>
                            {loadingStep === 3 ? "⏳" : loadingStep > 3 ? "✅" : "⏸️"} Checking existing filters
                        </p>
                        <p className={styles.loadingStep}>
                            {loadingStep === 4 ? "⏳" : loadingStep > 4 ? "✅" : "⏸️"} Getting accurate counts
                        </p>
                    </div>
                    <p className={styles.loadingNote}>This may take 30-60 seconds for accurate counts...</p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.dashboard}>
            <header className={styles.header}>
                <div className={styles.logo}>
                    <span className={styles.logoIcon}>🥷</span>
                    <span className={styles.logoGradient}>MailNinja</span>
                </div>
                <div className={styles.userSection}>
                    <button
                        onClick={handleRefresh}
                        disabled={isRefreshing}
                        className={styles.refreshBtn}
                    >
                        {isRefreshing ? "⏳" : "🔄"}
                    </button>
                    <span className={styles.userEmail}>{session?.user?.email}</span>
                    <button
                        onClick={() => signOut({ callbackUrl: "/" })}
                        className={styles.signOutBtn}
                    >
                        Sign out
                    </button>
                </div>
            </header>

            <main className={styles.main}>
                <h1 className={styles.pageTitle}>Inbox Dashboard</h1>
                <p className={styles.pageSubtitle}>
                    Here&apos;s what we found in your inbox
                </p>

                {/* Stats Grid */}
                <div className={styles.statsGrid}>
                    <div className={`card ${styles.statCard}`}>
                        <div className={styles.statValue}>
                            {analysis?.stats.isExact ? '' : '~'}{analysis?.stats.total || 0}
                        </div>
                        <div className={styles.statLabel}>Total Emails</div>
                    </div>

                    {analysis?.stats.categories && (
                        <>
                            <div className={`card ${styles.statCard}`}>
                                <div className={styles.statValue}>
                                    {analysis?.stats.isExact ? '' : '~'}{analysis?.stats.unread || 0}
                                </div>
                                <div className={styles.statLabel}>Unread</div>
                            </div>
                            <div className={`card ${styles.statCard}`}>
                                <div className={styles.statValue}>
                                    {(analysis?.stats.categories.primary || 0).toLocaleString()}
                                </div>
                                <div className={styles.statLabel}>Primary</div>
                            </div>
                            <div className={`card ${styles.statCard}`}>
                                <div className={styles.statValue}>
                                    {(analysis?.stats.categories.updates || 0).toLocaleString()}
                                </div>
                                <div className={styles.statLabel}>Updates</div>
                            </div>
                            <div className={`card ${styles.statCard}`}>
                                <div className={styles.statValue}>
                                    {(analysis?.stats.categories.promotions || 0).toLocaleString()}
                                </div>
                                <div className={styles.statLabel}>Promotions</div>
                            </div>
                            <div className={`card ${styles.statCard}`}>
                                <div className={styles.statValue}>
                                    {(analysis?.stats.categories.social || 0).toLocaleString()}
                                </div>
                                <div className={styles.statLabel}>Social</div>
                            </div>
                        </>
                    )}

                    {!analysis?.stats.categories && (
                        <div className={`card ${styles.statCard}`}>
                            <div className={styles.statValue}>
                                {analysis?.stats.isExact ? '' : '~'}{analysis?.stats.unread || 0}
                            </div>
                            <div className={styles.statLabel}>Unread</div>
                        </div>
                    )}

                    <div className={`card ${styles.statCard}`}>
                        <div className={styles.statValue}>{analysis?.clusters.length || 0}</div>
                        <div className={styles.statLabel}>Top Senders Analyzed</div>
                    </div>
                    <div className={`card ${styles.statCard}`}>
                        <div className={styles.statValue}>{analysis?.filterSuggestions.length || 0}</div>
                        <div className={styles.statLabel}>Actionable Ideas</div>
                    </div>
                </div>

                {/* Filter Suggestions */}
                {analysis?.filterSuggestions && analysis.filterSuggestions.length > 0 && (
                    <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                            <h2 className={styles.sectionTitle}>
                                <span className={styles.sectionIcon}>⚡</span>
                                Recommended Filters
                            </h2>
                        </div>
                        {analysis.filterSuggestions.slice(0, 5).map((suggestion) => (
                            <div key={suggestion.id} className={`card ${styles.filterCard}`}>
                                <div className={styles.filterHeader}>
                                    <div className={styles.filterContent}>
                                        <p className={styles.filterDescription}>
                                            {suggestion.description}
                                        </p>
                                        <div className={styles.filterLogicRow}>
                                            <code className={styles.filterCriteria}>
                                                {suggestion.criteria.from ? `from:${suggestion.criteria.from}` : ''}
                                                {' → '}
                                                {suggestion.action.skipInbox ? 'skip inbox' : 'keep in inbox'}
                                            </code>
                                        </div>
                                        {/* Metrics Row */}
                                        <div className={styles.filterMetrics}>
                                            {(suggestion.metrics?.primary || 0) > 0 && (
                                                <span className={`${styles.metricBadge} ${styles.metricPrimary}`}>
                                                    Primary: {suggestion.metrics!.primary}
                                                </span>
                                            )}
                                            {(suggestion.metrics?.updates || 0) > 0 && (
                                                <span className={`${styles.metricBadge} ${styles.metricUpdates}`}>
                                                    Updates: {suggestion.metrics!.updates}
                                                </span>
                                            )}
                                            {(suggestion.metrics?.promotions || 0) > 0 && (
                                                <span className={`${styles.metricBadge} ${styles.metricPromotions}`}>
                                                    Promotions: {suggestion.metrics!.promotions}
                                                </span>
                                            )}
                                            {(suggestion.metrics?.social || 0) > 0 && (
                                                <span className={`${styles.metricBadge} ${styles.metricSocial}`}>
                                                    Social: {suggestion.metrics!.social}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className={styles.filterActionsContainer}>
                                        {/* Primary Actions Row */}
                                        <div className={styles.filterActionsRow}>
                                            <button
                                                onClick={() => handleCreateFilter(suggestion)}
                                                className={styles.acceptBtn}
                                            >
                                                {suggestion.isGrouped ? "Review Senders & Create" : "Create Filter & Archive"}
                                            </button>
                                            <button
                                                onClick={() => handleArchiveOnly(suggestion)}
                                                className={styles.archiveOnlyBtn}
                                            >
                                                Archive Only
                                            </button>
                                            <button
                                                onClick={() => handleOpenLabelModal(suggestion)}
                                                className={styles.labelActionBtn}
                                            >
                                                🏷️ Move to Label
                                            </button>
                                        </div>
                                        {/* Secondary Actions Row */}
                                        <div className={styles.filterActionsRowSecondary}>
                                            <a
                                                href={suggestion.latestMessageId
                                                    ? `https://mail.google.com/mail/u/0/#inbox/${suggestion.latestMessageId}`
                                                    : `https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(suggestion.criteria.from || '')}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className={styles.secondaryBtn}
                                            >
                                                Open Latest
                                            </a>
                                            <a
                                                href={`https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(suggestion.criteria.from || '')}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className={styles.secondaryBtn}
                                            >
                                                View All
                                            </a>
                                            <button
                                                onClick={() => handleDismissSuggestion(suggestion.id)}
                                                className={styles.dismissBtn}
                                            >
                                                Dismiss
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </section>
                )}

                {/* Existing Filters */}
                {analysis?.existingFilters && analysis.existingFilters.length > 0 && (
                    <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                            <h2 className={styles.sectionTitle}>
                                <span className={styles.sectionIcon}>📋</span>
                                Active Filters
                            </h2>
                        </div>
                        {analysis.existingFilters.map((filter) => (
                            <div key={filter.id} className={`card ${styles.filterCard}`}>
                                <div className={styles.filterHeader}>
                                    <div>
                                        <p className={styles.filterDescription}>
                                            Filter for <strong>{filter.from}</strong>
                                        </p>
                                        <code className={styles.filterCriteria}>
                                            {filter.inboxCount > 0
                                                ? `${filter.inboxCountDisplay} emails still in inbox`
                                                : "✅ Inbox clear"}
                                        </code>
                                    </div>
                                    <div className={styles.filterActions}>
                                        {filter.inboxCount > 0 && (
                                            <button
                                                onClick={() => handleArchiveFromFilter(filter)}
                                                className={styles.archiveBtn}
                                            >
                                                Archive All
                                            </button>
                                        )}
                                        <a
                                            href={`https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(filter.from)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={styles.openBtn}
                                        >
                                            View All
                                        </a>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </section>
                )}
                <section className={styles.section}>
                    <div className={styles.sectionHeader}>
                        <h2 className={styles.sectionTitle}>
                            <span className={styles.sectionIcon}>📬</span>
                            Top Senders
                        </h2>
                    </div>

                    {analysis?.clusters && analysis.clusters.length > 0 ? (
                        <div className={styles.clusterList}>
                            {analysis.clusters.slice(0, 15).map((cluster) => (
                                <div key={cluster.sender} className={`card ${styles.clusterCard}`}>
                                    <div className={styles.clusterInfo}>
                                        <div className={styles.clusterSender}>
                                            {cluster.sender}
                                            {cluster.suggestedAction === "filter" && (
                                                <span className="badge badge-warning">High volume</span>
                                            )}
                                        </div>
                                        <div className={styles.clusterDomain}>{cluster.domain}</div>
                                    </div>
                                    <div className={styles.clusterMeta}>
                                        <div className={styles.clusterCount}>
                                            <div className={styles.clusterCountValue}>{cluster.countDisplay || cluster.count}</div>
                                            <div className={styles.clusterCountLabel}>emails</div>
                                        </div>
                                        <div className={styles.clusterActions}>
                                            <button
                                                onClick={() => handleArchive(cluster)}
                                                className={`${styles.actionBtn} ${styles.archiveBtn}`}
                                            >
                                                Archive All
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className={styles.emptyState}>
                            <div className={styles.emptyIcon}>📭</div>
                            <p>No email clusters found. Your inbox might already be clean!</p>
                        </div>
                    )}
                </section>

                {/* Trusted Senders Section - Disabled for serverless deployment
                {trustedSenders.length > 0 && (
                    <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                            <h2 className={styles.sectionTitle}>Trusted Senders</h2>
                            <p className={styles.sectionSubtitle}>
                                These senders are excluded from future filter recommendations.
                            </p>
                        </div>
                        <div className={styles.trustedList}>
                            {trustedSenders.map(email => (
                                <div key={email} className={styles.trustedItem}>
                                    <span className={styles.trustedEmail}>{email}</span>
                                    <button
                                        onClick={async () => {
                                            try {
                                                await fetch(`/api/settings/trusted?email=${encodeURIComponent(email)}`, {
                                                    method: "DELETE"
                                                });
                                                setTrustedSenders(prev => prev.filter(e => e !== email));
                                                showToast(`Removed ${email} from trusted senders`, "success");
                                            } catch (error) {
                                                console.error("Failed to remove trusted sender", error);
                                                showToast("Failed to remove trusted sender", "error");
                                            }
                                        }}
                                        className={styles.removeTrustedBtn}
                                        title="Remove from trusted list"
                                    >
                                        Remove trust
                                    </button>
                                </div>
                            ))}
                        </div>
                    </section>
                )}
                */}
            </main>

            {/* Review Modal */}
            {reviewModalOpen && selectedSuggestion && (
                <div className={styles.modalOverlay}>
                    <div className={styles.modal}>
                        <div className={styles.modalHeader}>
                            <div>
                                <h3 className={styles.modalTitle}>Review Senders</h3>
                                <p className={styles.modalSubtitle}>
                                    Showing senders found in your recent emails.
                                    This filter will apply to the entire <strong>{selectedSuggestion.criteria.from?.replace('from:', '')}</strong> domain.
                                </p>
                            </div>
                            <div className={styles.totalBadge}>
                                <span className={styles.totalLabel}>Total Impact</span>
                                <span className={styles.totalValue}>{selectedSuggestion.matchCount} emails</span>
                            </div>
                        </div>

                        <div className={styles.senderList}>
                            {selectedSuggestion.senderDetails?.map((sender) => (
                                <div key={sender.email} className={styles.senderItem}>
                                    <label className={styles.senderCheckbox}>
                                        <input
                                            type="checkbox"
                                            checked={!excludedSenders.has(sender.email)}
                                            onChange={(e) => {
                                                const newExcluded = new Set(excludedSenders);
                                                if (e.target.checked) {
                                                    newExcluded.delete(sender.email);
                                                } else {
                                                    newExcluded.add(sender.email);
                                                }
                                                setExcludedSenders(newExcluded);
                                            }}
                                        />
                                        <div className={styles.senderContent}>
                                            <div className={styles.senderHeader}>
                                                <span className={styles.senderEmail}>{sender.email}</span>
                                                {sender.shouldArchive ? (
                                                    <span className={`${styles.badge} ${styles.badgeArchive}`}>
                                                        Archive
                                                    </span>
                                                ) : (
                                                    <span className={`${styles.badge} ${styles.badgeKeep}`}>
                                                        Keep
                                                    </span>
                                                )}
                                            </div>
                                            <div className={styles.senderMeta}>
                                                <span className={styles.senderReason}>
                                                    {sender.shouldArchive ? "📧 " : "⚠️ "}{sender.reason}
                                                </span>
                                            </div>
                                        </div>
                                        <a
                                            href={`https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(sender.email)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={styles.senderViewLink}
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            View
                                        </a>
                                    </label>
                                </div>
                            ))}
                        </div>

                        <div className={styles.modalActions}>
                            <button
                                className={styles.cancelBtn}
                                onClick={() => {
                                    setReviewModalOpen(false);
                                    setSelectedSuggestion(null);
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                className={styles.confirmBtn}
                                onClick={handleConfirmFilter}
                            >
                                Create Filter ({selectedSuggestion.senderDetails!.length - excludedSenders.size} senders)
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Label Modal */}
            {labelModalOpen && labelModalSuggestion && (
                <div className={styles.modalOverlay}>
                    <div className={styles.modal}>
                        <div className={styles.modalHeader}>
                            <h3 className={styles.modalTitle}>Move to Label</h3>
                            <p className={styles.modalSubtitle}>
                                Create a filter for <strong>{labelModalSuggestion.criteria.from}</strong> and apply a label to all matching emails.
                            </p>
                        </div>

                        <div className={styles.labelForm}>
                            <div className={styles.formGroup}>
                                <label className={styles.formLabel}>Select Label</label>
                                <select
                                    value={selectedLabelName}
                                    onChange={(e) => setSelectedLabelName(e.target.value)}
                                    className={styles.labelSelect}
                                >
                                    <option value="">-- Choose a label --</option>
                                    {availableLabels.map((label) => (
                                        <option key={label.id} value={label.name}>
                                            {label.name}
                                        </option>
                                    ))}
                                    <option value="__new__">➕ Create new label...</option>
                                </select>
                            </div>

                            {selectedLabelName === "__new__" && (
                                <div className={styles.formGroup}>
                                    <label className={styles.formLabel}>New Label Name</label>
                                    <input
                                        type="text"
                                        value={newLabelName}
                                        onChange={(e) => setNewLabelName(e.target.value)}
                                        placeholder="e.g. Newsletters/Tech"
                                        className={styles.labelInput}
                                    />
                                    <p className={styles.formHint}>
                                        Use / for nested labels (e.g. &quot;Parent/Child&quot;)
                                    </p>
                                </div>
                            )}

                            <div className={styles.formGroup}>
                                <label className={styles.checkboxLabel}>
                                    <input
                                        type="checkbox"
                                        checked={skipInboxChecked}
                                        onChange={(e) => setSkipInboxChecked(e.target.checked)}
                                    />
                                    <span>Skip inbox (archive after labeling)</span>
                                </label>
                            </div>
                        </div>

                        <div className={styles.modalActions}>
                            <button
                                className={styles.cancelBtn}
                                onClick={() => {
                                    setLabelModalOpen(false);
                                    setLabelModalSuggestion(null);
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                className={styles.confirmBtn}
                                onClick={handleConfirmLabelAction}
                                disabled={!selectedLabelName || (selectedLabelName === "__new__" && !newLabelName)}
                            >
                                Create Filter & Apply Label
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Processing overlay */}
            {isProcessing && (
                <div className={styles.processingOverlay}>
                    <div className={styles.processingModal}>
                        <div className="spinner" />
                        <h3 className={styles.processingTitle}>Processing...</h3>
                        <p className={styles.processingMessage}>{processingMessage}</p>
                        <p className={styles.processingNote}>This may take a moment for large mailboxes</p>
                    </div>
                </div>
            )}

            {/* Toast notification */}
            {toast && (
                <div className={`${styles.toast} ${toast.type === "success" ? styles.toastSuccess : styles.toastError}`}>
                    {toast.message}
                </div>
            )}
        </div>
    );
}
