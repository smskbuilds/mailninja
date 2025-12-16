import fs from 'fs/promises';
import path from 'path';

const STORAGE_FILE = path.join(process.cwd(), 'trusted-senders.json');

export async function getTrustedSenders(): Promise<string[]> {
    try {
        const data = await fs.readFile(STORAGE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // If file doesn't exist or is invalid, return empty array
        return [];
    }
}

export async function addTrustedSenders(emails: string[]): Promise<string[]> {
    const current = await getTrustedSenders();
    const newSet = new Set([...current, ...emails]);
    const updated = Array.from(newSet);

    await fs.writeFile(STORAGE_FILE, JSON.stringify(updated, null, 2));
    return updated;
}

export async function removeTrustedSender(email: string): Promise<string[]> {
    const current = await getTrustedSenders();
    const updated = current.filter(e => e !== email);

    await fs.writeFile(STORAGE_FILE, JSON.stringify(updated, null, 2));
    return updated;
}
