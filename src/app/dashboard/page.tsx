"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import styles from "./page.module.css";

interface EmailCluster {
    domain: string;
    sender: string;
    count: number;
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

interface AnalysisResult {
    stats: InboxStats;
    clusters: EmailCluster[];
    filterSuggestions: FilterSuggestion[];
}

export default function Dashboard() {
    const { data: session, status } = useSession();
    const router = useRouter();

    const [isLoading, setIsLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

    const showToast = (message: string, type: "success" | "error") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    };

    const fetchAnalysis = useCallback(async () => {
        if (!session?.accessToken) return;

        try {
            const response = await fetch("/api/gmail/analyze");
            if (!response.ok) throw new Error("Failed to analyze inbox");
            const data = await response.json();
            setAnalysis(data);
        } catch (error) {
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
        try {
            const response = await fetch("/api/gmail/actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "createFilter",
                    criteria: suggestion.criteria,
                    filterAction: suggestion.action,
                }),
            });

            if (!response.ok) throw new Error("Failed to create filter");

            showToast(`Filter created for ${suggestion.criteria.from}`, "success");

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
                    <p className={styles.loadingText}>Analyzing your inbox...</p>
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
                                            Create Filter
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

                {/* Sender Clusters */}
                <section className={styles.section}>
                    <div className={styles.sectionHeader}>
                        <h2 className={styles.sectionTitle}>
                            <span className={styles.sectionIcon}>📬</span>
                            Top Senders
                        </h2>
                        <button
                            onClick={handleRefresh}
                            disabled={isRefreshing}
                            className={styles.refreshBtn}
                        >
                            {isRefreshing ? "Refreshing..." : "🔄 Refresh"}
                        </button>
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
                                            <div className={styles.clusterCountValue}>{cluster.count}</div>
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

            {/* Toast notification */}
            {toast && (
                <div className={`${styles.toast} ${toast.type === "success" ? styles.toastSuccess : styles.toastError}`}>
                    {toast.message}
                </div>
            )}
        </div>
    );
}
