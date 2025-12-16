import { NextResponse } from 'next/server';
import { getTrustedSenders, addTrustedSenders, removeTrustedSender } from '@/lib/store';

export async function GET() {
    try {
        const senders = await getTrustedSenders();
        return NextResponse.json({ senders });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch trusted senders' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const { emails } = await request.json();
        if (!emails || !Array.isArray(emails)) {
            return NextResponse.json({ error: 'Invalid emails provided' }, { status: 400 });
        }

        const updated = await addTrustedSenders(emails);
        return NextResponse.json({ senders: updated });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to add trusted senders' }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const email = searchParams.get('email');

        if (!email) {
            return NextResponse.json({ error: 'Email required' }, { status: 400 });
        }

        const updated = await removeTrustedSender(email);
        return NextResponse.json({ senders: updated });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to remove trusted sender' }, { status: 500 });
    }
}
