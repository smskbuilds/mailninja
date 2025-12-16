"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
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
}

interface InboxStats {
    total: number;
    unread: number;
    isExact: boolean;
    clusters: number;
    filterSuggestions: number;
}

interface ExistingFilter {
    id: string;
    from: string;
    inboxCount: number;
    inboxCountDisplay: string;
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

    const showToast = (message: string, type: "success" | "error") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    };

    const fetchAnalysis = useCallback(async () => {
        if (!session?.accessToken) return;

        // Simulate progress stages during the API call
        setLoadingStage("Connecting to Gmail...");

        // Start showing progress while API works
        const progressInterval = setInterval(() => {
            setLoadingStage(prev => {
                if (prev.includes("Connecting")) return "Getting inbox stats...";
                if (prev.includes("inbox stats")) return "Fetching recent emails...";
                if (prev.includes("emails")) return "Checking existing filters...";
                if (prev.includes("existing filters")) return "Getting accurate counts...";
                return prev;
            });
        }, 2000);

        try {
            const response = await fetch("/api/gmail/analyze");
            clearInterval(progressInterval);
            setLoadingStage("Finishing up...");

            if (!response.ok) throw new Error("Failed to analyze inbox");
            const data = await response.json();
            setAnalysis(data);
        } catch (error) {
            clearInterval(progressInterval);
            console.error("Analysis error:", error);
            showToast("Failed to analyze inbox", "error");
        } finally {
            setIsLoading(false);
            setIsRefreshing(false);
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
        setIsProcessing(true);
        setProcessingMessage(`Creating filter and archiving emails from ${suggestion.criteria.from}...`);

        try {
            const response = await fetch("/api/gmail/actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "createFilter",
                    criteria: suggestion.criteria,
                    filterAction: suggestion.action,
                    archiveExisting: true, // Also archive existing emails from this sender
                }),
            });

            if (!response.ok) throw new Error("Failed to create filter");

            const result = await response.json();
            const archivedCount = result.archivedCount || 0;

            showToast(
                `Filter created for ${suggestion.criteria.from}` +
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
        } catch (error) {
            console.error("Filter error:", error);
            showToast("Failed to create filter", "error");
        } finally {
            setIsProcessing(false);
            setProcessingMessage("");
        }
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

            // Refresh to update counts
            fetchAnalysis();
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
                    <div className="spinner" />
                    <h2 className={styles.loadingTitle}>Analyzing Your Inbox</h2>
                    <p className={styles.loadingStage}>{loadingStage}</p>
                    <div className={styles.loadingSteps}>
                        <p className={styles.loadingStep}>
                            {loadingStage.includes("Connecting") ? "⏳" : "✅"} Connecting to Gmail
                        </p>
                        <p className={styles.loadingStep}>
                            {loadingStage.includes("inbox stats") ? "⏳" :
                                loadingStage.includes("Connecting") ? "⏸️" : "✅"} Getting inbox stats
                        </p>
                        <p className={styles.loadingStep}>
                            {loadingStage.includes("emails") ? "⏳" :
                                loadingStage.includes("Connecting") || loadingStage.includes("inbox stats") ? "⏸️" : "✅"} Fetching recent emails
                        </p>
                        <p className={styles.loadingStep}>
                            {loadingStage.includes("existing filters") ? "⏳" :
                                loadingStage.includes("Connecting") || loadingStage.includes("inbox stats") || loadingStage.includes("emails") ? "⏸️" : "✅"} Checking existing filters
                        </p>
                        <p className={styles.loadingStep}>
                            {loadingStage.includes("counts") ? "⏳" :
                                loadingStage.includes("Finishing") ? "✅" : "⏸️"} Getting accurate counts
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
                    <div className={`card ${styles.statCard}`}>
                        <div className={styles.statValue}>
                            {analysis?.stats.isExact ? '' : '~'}{analysis?.stats.unread || 0}
                        </div>
                        <div className={styles.statLabel}>Unread</div>
                    </div>
                    <div className={`card ${styles.statCard}`}>
                        <div className={styles.statValue}>{analysis?.clusters.length || 0}</div>
                        <div className={styles.statLabel}>Sender Groups</div>
                    </div>
                    <div className={`card ${styles.statCard}`}>
                        <div className={styles.statValue}>{analysis?.filterSuggestions.length || 0}</div>
                        <div className={styles.statLabel}>Filter Suggestions</div>
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
                                    <div>
                                        <p className={styles.filterDescription}>{suggestion.description}</p>
                                        <code className={styles.filterCriteria}>
                                            from:{suggestion.criteria.from} → skip inbox
                                        </code>
                                    </div>
                                    <div className={styles.filterActions}>
                                        <button
                                            onClick={() => handleCreateFilter(suggestion)}
                                            className={styles.acceptBtn}
                                        >
                                            Create Filter & Archive All
                                        </button>
                                        <a
                                            href={suggestion.latestMessageId
                                                ? `https://mail.google.com/mail/u/0/#inbox/${suggestion.latestMessageId}`
                                                : `https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(suggestion.criteria.from || '')}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={styles.openBtn}
                                        >
                                            Open Latest
                                        </a>
                                        <a
                                            href={`https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(suggestion.criteria.from || '')}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={styles.openBtn}
                                        >
                                            View All
                                        </a>
                                        <button
                                            onClick={() => handleDismissSuggestion(suggestion.id)}
                                            className={styles.rejectBtn}
                                        >
                                            Dismiss
                                        </button>
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
                        {analysis.existingFilters
                            .filter(f => f.inboxCount > 0)
                            .map((filter) => (
                                <div key={filter.id} className={`card ${styles.filterCard}`}>
                                    <div className={styles.filterHeader}>
                                        <div>
                                            <p className={styles.filterDescription}>
                                                Filter for <strong>{filter.from}</strong>
                                            </p>
                                            <code className={styles.filterCriteria}>
                                                {filter.inboxCountDisplay} emails still in inbox
                                            </code>
                                        </div>
                                        <div className={styles.filterActions}>
                                            <button
                                                onClick={() => handleArchiveFromFilter(filter)}
                                                className={styles.archiveBtn}
                                            >
                                                Archive All
                                            </button>
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
            </main>

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
