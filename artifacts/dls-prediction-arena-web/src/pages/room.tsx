import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
  Clipboard,
  Copy,
  LockKeyhole,
  Radio,
  RefreshCw,
  Shield,
  Trophy,
  UserRound,
  Users,
} from 'lucide-react';
import {
  getGetLeaderboardQueryKey,
  getGetRoomQueryKey,
  useGetLeaderboard,
  useGetRoom,
  useJoinRoom,
  useSubmitPrediction,
  type LeaderboardEntry,
  type Match,
} from '@workspace/api-client-react';

const ROOM_CODE = 'QBQ5V5';
const IDENTITY_KEY = 'dls-arena-guest';

type Outcome = 'home' | 'draw' | 'away';
type StoredIdentity = { id: string; name: string };
type Feedback = { tone: 'success' | 'error' | 'info'; message: string } | null;

function makeGuestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `guest-${crypto.randomUUID()}`;
  }
  return `guest-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function getStoredIdentity(): StoredIdentity {
  if (typeof window === 'undefined') return { id: makeGuestId(), name: '' };
  try {
    const value = window.localStorage.getItem(IDENTITY_KEY);
    if (!value) return { id: makeGuestId(), name: '' };
    const parsed = JSON.parse(value) as Partial<StoredIdentity>;
    return {
      id: typeof parsed.id === 'string' && parsed.id.length >= 3 ? parsed.id : makeGuestId(),
      name: typeof parsed.name === 'string' ? parsed.name : '',
    };
  } catch {
    return { id: makeGuestId(), name: '' };
  }
}

function formatKickoff(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Kickoff time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function MatchSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading fixtures" data-testid="loading-fixtures">
      {[1, 2, 3].map((item) => (
        <div
          className="h-[178px] animate-pulse rounded-[22px] border border-white/5 bg-white/[0.045]"
          key={item}
        />
      ))}
    </div>
  );
}

function OutcomeButton({
  label,
  odds,
  selected,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  odds: number;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      className={[
        'group relative min-h-[58px] flex-1 rounded-2xl border px-2 py-2 text-left transition duration-200',
        selected
          ? 'border-lime-300 bg-lime-300 text-ink shadow-[0_8px_24px_rgba(170,226,70,0.18)]'
          : 'border-white/10 bg-white/[0.035] text-cream hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.075]',
        disabled ? 'cursor-not-allowed opacity-45 hover:translate-y-0 hover:border-white/10 hover:bg-white/[0.035]' : '',
      ].join(' ')}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className={`block font-mono text-[10px] font-medium uppercase tracking-[0.18em] ${selected ? 'text-ink/65' : 'text-slate-400'}`}>
        {label}
      </span>
      <span className={`mt-1 block font-mono text-sm font-medium ${selected ? 'text-ink' : 'text-cream'}`}>
        {odds.toFixed(2)}
      </span>
      {selected ? <Check className="absolute right-2 top-2.5 h-3.5 w-3.5" strokeWidth={3} /> : null}
    </button>
  );
}

function FixtureCard({
  match,
  selectedOutcome,
  canPredict,
  onSelect,
  onSubmit,
  pending,
}: {
  match: Match;
  selectedOutcome?: Outcome;
  canPredict: boolean;
  onSelect: (outcome: Outcome) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  const locked = match.status !== 'scheduled';
  const finished = match.status === 'finished';
  const live = match.status === 'live';
  const statusLabel = finished ? 'Final' : live ? 'Live now' : 'Open for picks';

  return (
    <article
      className={`animate-rise rounded-[22px] border p-4 transition duration-300 sm:p-5 ${
        finished
          ? 'border-white/8 bg-white/[0.025]'
          : 'border-white/10 bg-card shadow-[0_18px_50px_rgba(0,0,0,0.14)] hover:border-white/20'
      }`}
      data-testid={`card-fixture-${match.id}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">
          {live ? <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-coral" /> : <CircleDot className="h-3 w-3 text-slate-500" />}
          <span data-testid={`status-fixture-${match.id}`}>{statusLabel}</span>
          <span className="text-slate-600">/</span>
          <span data-testid={`kickoff-fixture-${match.id}`}>{formatKickoff(match.kickoffAt)}</span>
        </div>
        {locked ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.045] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
            <LockKeyhole className="h-3 w-3" />
            {finished ? 'Settled' : 'Locked'}
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-lime-300">Pick one</span>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.03em] text-cream" data-testid={`text-home-team-${match.id}`}>
          {match.homeTeam}
        </span>
        <span className="shrink-0 font-mono text-[10px] tracking-[0.18em] text-slate-500">VS</span>
        <span className="min-w-0 truncate text-right text-[17px] font-semibold tracking-[-0.03em] text-cream" data-testid={`text-away-team-${match.id}`}>
          {match.awayTeam}
        </span>
      </div>

      {finished ? (
        <div className="mt-3 flex items-center justify-center gap-2 font-mono text-sm text-slate-300" data-testid={`score-fixture-${match.id}`}>
          <span>{match.homeScore ?? 0}</span>
          <span className="text-slate-600">—</span>
          <span>{match.awayScore ?? 0}</span>
        </div>
      ) : null}

      <div className="mt-4 flex gap-2">
        <OutcomeButton
          disabled={locked || !canPredict}
          label="Home"
          odds={match.homeOdds}
          onClick={() => onSelect('home')}
          selected={selectedOutcome === 'home'}
          testId={`button-pick-home-${match.id}`}
        />
        <OutcomeButton
          disabled={locked || !canPredict}
          label="Draw"
          odds={match.drawOdds}
          onClick={() => onSelect('draw')}
          selected={selectedOutcome === 'draw'}
          testId={`button-pick-draw-${match.id}`}
        />
        <OutcomeButton
          disabled={locked || !canPredict}
          label="Away"
          odds={match.awayOdds}
          onClick={() => onSelect('away')}
          selected={selectedOutcome === 'away'}
          testId={`button-pick-away-${match.id}`}
        />
      </div>

      {!locked ? (
        <button
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-lime-300/25 bg-lime-300/[0.08] py-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-lime-200 transition hover:bg-lime-300/[0.16] disabled:cursor-not-allowed disabled:opacity-40"
          data-testid={`button-submit-prediction-${match.id}`}
          disabled={!selectedOutcome || !canPredict || pending}
          onClick={onSubmit}
          type="button"
        >
          {pending ? 'Saving pick…' : 'Lock in prediction'}
          {!pending ? <ArrowUpRight className="h-3.5 w-3.5" /> : null}
        </button>
      ) : (
        <div className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-white/[0.03] py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          <LockKeyhole className="h-3 w-3" />
          Predictions closed
        </div>
      )}
    </article>
  );
}

function Leaderboard({ entries, loading, error }: { entries: LeaderboardEntry[]; loading: boolean; error: unknown }) {
  return (
    <section className="rounded-[24px] border border-white/10 bg-card p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)] sm:p-5" data-testid="section-leaderboard">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-lime-300">
            <Trophy className="h-4 w-4" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em]">Standings</span>
          </div>
          <h2 className="mt-2 text-xl font-bold tracking-[-0.04em] text-cream" data-testid="heading-leaderboard">Room leaderboard</h2>
        </div>
        <span className="rounded-full bg-white/[0.05] px-2.5 py-1 font-mono text-[10px] text-slate-400">{entries.length} players</span>
      </div>

      {loading ? (
        <div className="mt-5 space-y-2" aria-label="Loading leaderboard" data-testid="loading-leaderboard">
          {[1, 2, 3].map((item) => <div className="h-14 animate-pulse rounded-xl bg-white/[0.05]" key={item} />)}
        </div>
      ) : error && entries.length === 0 ? (
        <div className="mt-5 rounded-xl border border-coral/20 bg-coral/[0.07] p-3 text-sm text-coral/90" data-testid="error-leaderboard">
          {getErrorMessage(error, 'Standings could not be loaded.')}
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-dashed border-white/12 bg-white/[0.025] px-4 py-7 text-center" data-testid="empty-leaderboard">
          <Shield className="mx-auto h-6 w-6 text-slate-500" />
          <p className="mt-3 text-sm font-medium text-slate-300">The table is waiting on its first pick.</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">Make a prediction to put your name on the board.</p>
        </div>
      ) : (
        <div className="mt-5 space-y-2" data-testid="list-leaderboard">
          {entries.map((entry, index) => (
            <div
              className={`flex items-center gap-3 rounded-2xl border px-3 py-3 transition ${
                index === 0 ? 'border-lime-300/20 bg-lime-300/[0.07]' : 'border-white/7 bg-white/[0.025]'
              }`}
              data-testid={`row-leaderboard-${entry.playerId}`}
              key={entry.playerId}
            >
              <span className={`w-5 text-center font-mono text-xs ${index === 0 ? 'text-lime-300' : 'text-slate-500'}`}>{entry.rank}</span>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-medium ${index === 0 ? 'bg-lime-300 text-ink' : 'bg-white/10 text-slate-300'}`}>
                {initials(entry.playerName)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-cream" data-testid={`text-player-name-${entry.playerId}`}>{entry.playerName}</p>
                <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.11em] text-slate-500">
                  {entry.correct} correct <span className="text-slate-700">/</span> {entry.predictions} picks
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm font-medium text-lime-300" data-testid={`text-player-points-${entry.playerId}`}>{entry.points}</p>
                <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-slate-500">pts</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function RoomPage() {
  const queryClient = useQueryClient();
  const [identity, setIdentity] = useState<StoredIdentity>(getStoredIdentity);
  const [name, setName] = useState(identity.name);
  const [selectedByMatch, setSelectedByMatch] = useState<Record<string, Outcome>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [copied, setCopied] = useState(false);

  const roomQuery = useGetRoom(ROOM_CODE, {
    query: { queryKey: getGetRoomQueryKey(ROOM_CODE), staleTime: 15_000 },
  });
  const leaderboardQuery = useGetLeaderboard(ROOM_CODE, {
    query: { queryKey: getGetLeaderboardQueryKey(ROOM_CODE), staleTime: 15_000 },
  });
  const joinRoom = useJoinRoom();
  const submitPrediction = useSubmitPrediction();

  const room = roomQuery.data;
  const currentPlayer = useMemo(
    () => room?.players.find((player) => player.id === identity.id),
    [identity.id, room?.players],
  );
  const entries = leaderboardQuery.data ?? room?.leaderboard ?? [];
  const canPredict = Boolean(currentPlayer) && room?.status !== 'finished';

  useEffect(() => {
    if (!currentPlayer) return;
    try {
      const saved = window.localStorage.getItem(`dls-arena-picks-${ROOM_CODE}-${currentPlayer.id}`);
      if (saved) setSelectedByMatch(JSON.parse(saved) as Record<string, Outcome>);
    } catch {
      setSelectedByMatch({});
    }
  }, [currentPlayer]);

  useEffect(() => {
    const source = new EventSource(`/api/rooms/${ROOM_CODE}/events`);
    const refresh = () => {
      setSseConnected(true);
      void queryClient.invalidateQueries({ queryKey: getGetRoomQueryKey(ROOM_CODE) });
      void queryClient.invalidateQueries({ queryKey: getGetLeaderboardQueryKey(ROOM_CODE) });
    };
    source.onopen = () => setSseConnected(true);
    source.onmessage = refresh;
    source.onerror = () => setSseConnected(false);
    return () => source.close();
  }, [queryClient]);

  const handleJoin = () => {
    const cleanName = name.trim();
    if (cleanName.length < 2) {
      setFeedback({ tone: 'error', message: 'Use at least 2 characters for your display name.' });
      return;
    }
    joinRoom.mutate(
      { roomCode: ROOM_CODE, data: { playerId: identity.id, name: cleanName } },
      {
        onSuccess: (player) => {
          const nextIdentity = { id: player.id, name: player.name };
          setIdentity(nextIdentity);
          setName(player.name);
          window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(nextIdentity));
          setFeedback({ tone: 'success', message: `You’re in, ${player.name}. Make your picks.` });
          void queryClient.invalidateQueries({ queryKey: getGetRoomQueryKey(ROOM_CODE) });
          void queryClient.invalidateQueries({ queryKey: getGetLeaderboardQueryKey(ROOM_CODE) });
        },
        onError: (error) => setFeedback({ tone: 'error', message: getErrorMessage(error, 'Could not join this room.') }),
      },
    );
  };

  const selectOutcome = (matchId: string, outcome: Outcome) => {
    if (!currentPlayer) {
      setFeedback({ tone: 'info', message: 'Join the room above before making a prediction.' });
      return;
    }
    const next = { ...selectedByMatch, [matchId]: outcome };
    setSelectedByMatch(next);
    window.localStorage.setItem(`dls-arena-picks-${ROOM_CODE}-${currentPlayer.id}`, JSON.stringify(next));
    setFeedback(null);
  };

  const submitForMatch = (match: Match) => {
    const outcome = selectedByMatch[match.id];
    if (!outcome || !currentPlayer) return;
    submitPrediction.mutate(
      { roomCode: ROOM_CODE, data: { playerId: currentPlayer.id, matchId: match.id, outcome } },
      {
        onSuccess: () => {
          setFeedback({ tone: 'success', message: `${match.homeTeam} v ${match.awayTeam} is locked in.` });
          void queryClient.invalidateQueries({ queryKey: getGetRoomQueryKey(ROOM_CODE) });
          void queryClient.invalidateQueries({ queryKey: getGetLeaderboardQueryKey(ROOM_CODE) });
        },
        onError: (error) => setFeedback({ tone: 'error', message: getErrorMessage(error, 'That prediction could not be saved.') }),
      },
    );
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(ROOM_CODE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setFeedback({ tone: 'info', message: 'Room code: QBQ5V5' });
    }
  };

  if (roomQuery.isLoading) {
    return (
      <main className="soft-noise min-h-[100dvh] bg-ink pitch-grid px-4 py-6 text-cream sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="h-8 w-40 animate-pulse rounded bg-white/10" />
          <div className="mt-10 h-44 animate-pulse rounded-[28px] bg-white/[0.05]" />
          <div className="mt-6 max-w-2xl"><MatchSkeleton /></div>
        </div>
      </main>
    );
  }

  if (roomQuery.isError || !room) {
    return (
      <main className="soft-noise flex min-h-[100dvh] items-center justify-center bg-ink pitch-grid px-5 text-cream">
        <section className="w-full max-w-md rounded-[26px] border border-coral/20 bg-card p-6 text-center shadow-2xl" data-testid="error-room">
          <AlertCircle className="mx-auto h-8 w-8 text-coral" />
          <h1 className="mt-4 text-2xl font-bold tracking-[-0.04em]">Room unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            {getErrorMessage(roomQuery.error, 'Friday Night League could not be loaded right now.')}
          </p>
          <button
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-lime-300 px-4 py-3 font-mono text-xs font-medium uppercase tracking-[0.14em] text-ink transition hover:bg-lime-200"
            data-testid="button-retry-room"
            onClick={() => void roomQuery.refetch()}
            type="button"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="soft-noise min-h-[100dvh] bg-ink pitch-grid text-cream">
      <div className="mx-auto max-w-6xl px-4 pb-12 pt-5 sm:px-6 sm:pt-7 lg:px-8">
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-lime-300 text-ink shadow-[0_0_0_5px_rgba(170,226,70,0.08)]">
              <Radio className="h-4 w-4" strokeWidth={2.5} />
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-lime-300">DLS / live room</p>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">Match night companion</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${sseConnected ? 'animate-pulse-dot bg-lime-300' : 'bg-slate-600'}`} />
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">{sseConnected ? 'Live sync' : 'Connecting'}</span>
          </div>
        </header>

        <section className="animate-rise relative mt-8 overflow-hidden rounded-[28px] border border-white/10 bg-card px-5 py-6 shadow-[0_24px_80px_rgba(0,0,0,0.25)] sm:px-8 sm:py-8">
          <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-lime-300/[0.08] blur-3xl" />
          <div className="relative">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-coral/30 bg-coral/[0.09] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-coral">Friday night</span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-slate-400">{room.status}</span>
            </div>
            <div className="mt-4 flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">Room {room.code}</p>
                <h1 className="mt-2 max-w-xl text-[clamp(2.3rem,8vw,4.6rem)] font-bold leading-[0.94] tracking-[-0.075em] text-cream" data-testid="text-room-name">{room.name}</h1>
                <p className="mt-4 max-w-md text-sm leading-6 text-slate-400">Read the odds. Trust the read. Climb the table before the final whistle.</p>
              </div>
              <div className="flex gap-2">
                <button
                  className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.045] px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-300 transition hover:border-lime-300/35 hover:text-lime-200"
                  data-testid="button-copy-room-code"
                  onClick={() => void copyCode()}
                  type="button"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-lime-300" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy code'}
                </button>
              </div>
            </div>
            <div className="mt-7 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-2xl border border-white/8 bg-white/[0.035] px-3 py-3" data-testid="stat-players">
                <Users className="h-4 w-4 text-lime-300" />
                <p className="mt-3 font-mono text-lg text-cream">{room.playerCount}<span className="text-slate-500">/{room.maxPlayers}</span></p>
                <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">Players in</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.035] px-3 py-3" data-testid="stat-fixtures">
                <Clipboard className="h-4 w-4 text-coral" />
                <p className="mt-3 font-mono text-lg text-cream">{room.matches.length}</p>
                <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">Fixtures</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.035] px-3 py-3" data-testid="stat-room-code">
                <span className="font-mono text-xs text-lime-300">#</span>
                <p className="mt-3 font-mono text-lg text-cream">{room.code}</p>
                <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">Room code</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.035] px-3 py-3" data-testid="stat-access">
                <Shield className="h-4 w-4 text-slate-300" />
                <p className="mt-3 font-mono text-lg text-cream">{currentPlayer ? 'IN' : 'OPEN'}</p>
                <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">Your status</p>
              </div>
            </div>
          </div>
        </section>

        {!currentPlayer ? (
          <section className="animate-sweep mt-5 rounded-[22px] border border-lime-300/20 bg-lime-300/[0.07] p-4 sm:p-5" data-testid="section-join-room">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="flex-1">
                <div className="flex items-center gap-2 text-lime-300">
                  <UserRound className="h-4 w-4" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Join the room</span>
                </div>
                <label className="mt-3 block text-sm font-medium text-cream" htmlFor="display-name">Choose your display name</label>
                <input
                  className="mt-2 h-12 w-full rounded-xl border border-white/12 bg-ink/45 px-3.5 text-sm text-cream outline-none transition placeholder:text-slate-600 focus:border-lime-300/60 focus:ring-2 focus:ring-lime-300/10"
                  data-testid="input-display-name"
                  id="display-name"
                  maxLength={24}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Night Shift"
                  value={name}
                />
              </div>
              <button
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-lime-300 px-5 font-mono text-xs font-medium uppercase tracking-[0.15em] text-ink transition hover:-translate-y-0.5 hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="button-join-room"
                disabled={joinRoom.isPending}
                onClick={handleJoin}
                type="button"
              >
                {joinRoom.isPending ? 'Joining…' : 'Join & predict'}
                {!joinRoom.isPending ? <ChevronRight className="h-4 w-4" /> : null}
              </button>
            </div>
            <p className="mt-3 font-mono text-[10px] leading-5 text-slate-500">Your name and player key stay on this device so reloads keep your seat.</p>
          </section>
        ) : (
          <section className="mt-5 flex items-center justify-between gap-3 rounded-[20px] border border-white/8 bg-white/[0.035] px-4 py-3" data-testid="section-current-player">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-lime-300 font-mono text-xs font-bold text-ink">{initials(currentPlayer.name)}</span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-cream" data-testid="text-current-player">{currentPlayer.name}</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-500">You are playing</p>
              </div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-lime-300"><Check className="h-3.5 w-3.5" /> Active</span>
          </section>
        )}

        {feedback ? (
          <div className={`mt-4 flex items-center gap-2 rounded-xl border px-3.5 py-3 text-sm ${
            feedback.tone === 'success' ? 'border-lime-300/20 bg-lime-300/[0.07] text-lime-200' :
              feedback.tone === 'error' ? 'border-coral/25 bg-coral/[0.07] text-coral' : 'border-white/10 bg-white/[0.04] text-slate-300'
          }`} data-testid={`feedback-${feedback.tone}`}>
            {feedback.tone === 'success' ? <Check className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
            <span>{feedback.message}</span>
          </div>
        ) : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <section>
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-coral">The card</p>
                <h2 className="mt-1.5 text-2xl font-bold tracking-[-0.05em] text-cream" data-testid="heading-fixtures">Tonight’s fixtures</h2>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-slate-500">1X2 / decimal odds</span>
            </div>
            {room.matches.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-white/12 bg-white/[0.025] p-8 text-center" data-testid="empty-fixtures">
                <Clipboard className="mx-auto h-7 w-7 text-slate-500" />
                <p className="mt-3 text-sm font-medium text-slate-300">No fixtures have been posted yet.</p>
                <p className="mt-1 text-xs text-slate-500">Stay in the room; the card will update live.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {room.matches.map((match) => (
                  <FixtureCard
                    canPredict={canPredict}
                    key={match.id}
                    match={match}
                    onSelect={(outcome) => selectOutcome(match.id, outcome)}
                    onSubmit={() => submitForMatch(match)}
                    pending={submitPrediction.isPending && submitPrediction.variables?.data.matchId === match.id}
                    selectedOutcome={selectedByMatch[match.id]}
                  />
                ))}
              </div>
            )}
          </section>
          <aside className="lg:sticky lg:top-5">
            <Leaderboard entries={entries} error={leaderboardQuery.error} loading={leaderboardQuery.isLoading} />
            <div className="mt-4 rounded-[22px] border border-white/8 bg-white/[0.025] p-4" data-testid="card-how-it-works">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">How it works</p>
              <div className="mt-3 space-y-3 text-xs leading-5 text-slate-400">
                <p><span className="mr-2 font-mono text-lime-300">01</span>Choose Home, Draw, or Away before kickoff.</p>
                <p><span className="mr-2 font-mono text-lime-300">02</span>You can replace a pick until the match locks.</p>
                <p><span className="mr-2 font-mono text-lime-300">03</span>Correct calls move you up the table.</p>
              </div>
            </div>
          </aside>
        </div>
        <footer className="mt-10 flex items-center justify-between border-t border-white/8 pt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">
          <span>Friday Night League</span>
          <span>Room {ROOM_CODE}</span>
        </footer>
      </div>
    </main>
  );
}