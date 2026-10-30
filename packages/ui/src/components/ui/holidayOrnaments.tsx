import * as React from 'react';

// Drawings of real things: a flag, a tree, a cocktail. Their colours are the
// thing's own and stay the same in every theme (see easter-eggs DOCUMENTATION.md).
// `variant` is the piece's place in the burst, so pieces of one ornament differ in colour.

export type HolidayOrnament =
  | 'heart' | 'clover' | 'lantern' | 'envelope' | 'crescent' | 'fanous' | 'goldStar'
  | 'tree' | 'bauble' | 'gift' | 'dreidel' | 'uaFlag' | 'sunflower' | 'uaStar' | 'usFlag' | 'usStar'
  | 'turkey' | 'pie' | 'mapleLeaf' | 'flower' | 'sunglasses' | 'beachUmbrella' | 'cocktail'
  | 'book' | 'rainUmbrella' | 'snowflake';

type OrnamentProps = { variant: number };

const pickColor = (colors: readonly string[], variant: number) => colors[variant % colors.length];

const STAR = 'M12 2.5l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.7 6.2 20l1.4-6.4-4.9-4.4 6.5-.7z';
const HEART = 'M12 21.3l-1.4-1.3C5.4 15.4 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1C13.1 3.8 14.8 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.9-8.6 11.5L12 21.3z';
const FLAG = 'M3 5c3-1.6 6-1.6 9 0s6 1.6 9 0v12c-3 1.6-6 1.6-9 0s-6-1.6-9 0z';
const MAPLE = 'M12 1.5 13.7 5.4 16.2 4.3 15.6 8.9 19.3 6.7 18.3 10.3 21.6 11.1 17.6 14.6 18.5 16.6 13.6 15.9 13.2 16.2 12.6 16.4 12.6 22 11.4 22 11.4 16.4 10.8 16.2 10.4 15.9 5.5 16.6 6.4 14.6 2.4 11.1 5.7 10.3 4.7 6.7 8.4 8.9 7.8 4.3 10.3 5.4Z';

const Heart = ({ variant }: OrnamentProps) => (
  <path d={HEART} fill={pickColor(['#f43f5e', '#fb7185', '#e11d48', '#f9a8d4'], variant)} />
);

const Clover = ({ variant }: OrnamentProps) => {
  const color = pickColor(['#22c55e', '#4ade80', '#16a34a', '#86efac'], variant);
  return (
    <>
      <path d="M12 12c3.2 2.4 5.4 5.4 6 9.6" stroke={color} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      {[45, 135, 225, 315].map((angle) => (
        <path
          key={angle}
          d="M12 11.4C10.2 9.6 8 8 8 5.6 8 4.1 9 3 10.3 3c.8 0 1.4.4 1.7 1 .3-.6.9-1 1.7-1C15 3 16 4.1 16 5.6c0 2.4-2.2 4-4 5.8z"
          fill={color}
          stroke="var(--surface-background)"
          strokeWidth="0.7"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </>
  );
};

const Lantern = () => (
  <>
    <path d="M12 1v2.5" stroke="#facc15" strokeWidth="1.2" />
    <rect x="8.5" y="3.2" width="7" height="2.2" rx="0.6" fill="#facc15" />
    <ellipse cx="12" cy="12" rx="8" ry="7" fill="#ef4444" />
    <path d="M12 5.2c-2.6 2-2.6 11.6 0 13.6M12 5.2c2.6 2 2.6 11.6 0 13.6" fill="none" stroke="#b91c1c" strokeWidth="1" />
    <rect x="8.5" y="18.6" width="7" height="2.2" rx="0.6" fill="#facc15" />
    <path d="M12 20.8v2.6" stroke="#facc15" strokeWidth="1.6" strokeLinecap="round" />
  </>
);

const Envelope = () => (
  <>
    <rect x="5" y="2.5" width="14" height="19" rx="1.6" fill="#dc2626" />
    <path d="M5.3 3.6 12 9.4l6.7-5.8" fill="none" stroke="#b91c1c" strokeWidth="1.2" />
    <circle cx="12" cy="10" r="2.6" fill="#facc15" />
  </>
);

const Crescent = () => (
  <>
    <path d="M14.5 2.5A9.6 9.6 0 1 0 21 18.6 8 8 0 1 1 14.5 2.5z" fill="#facc15" />
    <path d="M17.4 6.4l.8 1.8 2 .2-1.5 1.3.5 1.9-1.8-1-1.8 1 .5-1.9-1.5-1.3 2-.2z" fill="#fde68a" />
  </>
);

const Fanous = ({ variant }: OrnamentProps) => (
  <>
    <path d="M12 .8v2.2" stroke="#a8a29e" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M9 3h6l1.4 2.6H7.6z" fill="#d97706" />
    <path d="M7.6 5.6h8.8l1.6 4.6-1.6 7.4H7.6L6 10.2z" fill={pickColor(['#0d9488', '#7c3aed', '#2563eb'], variant)} />
    <path d="M12 5.6v12M7 10.2h10" stroke="#f59e0b" strokeWidth="1" />
    <ellipse cx="12" cy="11.6" rx="2" ry="3" fill="#fde68a" opacity="0.85" />
    <path d="M7.6 17.6h8.8l-1.4 2.4H9z" fill="#d97706" />
    <path d="M12 20v2.8" stroke="#f59e0b" strokeWidth="1.4" strokeLinecap="round" />
  </>
);

const GoldStar = () => <path d={STAR} fill="#fbbf24" />;

const Tree = () => (
  <>
    <path d="M12 3 5 12h3.4L4.5 17.5h15L15.6 12H19z" fill="#16a34a" />
    <path d="M10.6 17.5h2.8V21h-2.8z" fill="#92400e" />
    <path d="M12 .8l.8 1.7 1.8.2-1.4 1.2.4 1.8L12 4.8l-1.6.9.4-1.8-1.4-1.2 1.8-.2z" fill="#facc15" />
    <circle cx="10" cy="11" r=".9" fill="#ef4444" />
    <circle cx="14.2" cy="14.6" r=".9" fill="#facc15" />
    <circle cx="9" cy="15.4" r=".9" fill="#60a5fa" />
  </>
);

const Bauble = ({ variant }: OrnamentProps) => (
  <>
    <path d="M12 1.2c-1.4 0-1.8 1.4-.9 2.2M12 1.2c1.4 0 1.8 1.4.9 2.2" fill="none" stroke="#a8a29e" strokeWidth="1" />
    <rect x="9.6" y="3.2" width="4.8" height="3" rx=".6" fill="#facc15" />
    <circle cx="12" cy="14" r="8" fill={pickColor(['#dc2626', '#2563eb', '#9333ea', '#16a34a', '#f59e0b'], variant)} />
    <path d="M4.4 12.2c2.6 1.6 12.6 1.6 15.2 0M4.6 16.2c2.6 1.6 12.2 1.6 14.8 0" fill="none" stroke="#fde68a" strokeWidth="1" opacity=".8" />
    <ellipse cx="9" cy="10.6" rx="1.6" ry="2.4" fill="#fff" opacity=".45" transform="rotate(35 9 10.6)" />
  </>
);

const GIFT_BOX = ['#dc2626', '#2563eb', '#16a34a', '#9333ea'];
const GIFT_LID = ['#ef4444', '#3b82f6', '#22c55e', '#a855f7'];

const Gift = ({ variant }: OrnamentProps) => (
  <>
    <rect x="3.5" y="9" width="17" height="12.5" rx="1" fill={pickColor(GIFT_BOX, variant)} />
    <rect x="2.5" y="6.5" width="19" height="4" rx="1" fill={pickColor(GIFT_LID, variant)} />
    <path d="M12 6.5v15" stroke="#facc15" strokeWidth="2.4" />
    <path
      d="M12 6.4C10 2.6 6.6 3 7.2 5.2c.4 1.4 3 1.4 4.8 1.2zM12 6.4c2-3.8 5.4-3.4 4.8-1.2-.4 1.4-3 1.4-4.8 1.2z"
      fill="none"
      stroke="#facc15"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </>
);

// A dreidel showing gimel.
const Dreidel = () => (
  <>
    <path d="M12 1.5v4" stroke="#a8a29e" strokeWidth="2" strokeLinecap="round" />
    <path d="M5.5 5.5h13v8.5L12 22.5 5.5 14z" fill="#3b82f6" />
    <path d="M5.5 5.5h13v2.2h-13z" fill="#1d4ed8" />
    <path d="M10.2 9.4h2.6v5.2l1.6 1.8M12.8 13.4l-2.8 2.8" fill="none" stroke="#facc15" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </>
);

const FlagPole = () => <path d="M3 4v18" stroke="#a8a29e" strokeWidth="1.3" strokeLinecap="round" />;

const UaFlag = () => (
  <>
    <FlagPole />
    <path d={FLAG} fill="#facc15" />
    <path d="M3 5c3-1.6 6-1.6 9 0s6 1.6 9 0v6c-3 1.6-6 1.6-9 0s-6-1.6-9 0z" fill="#2563eb" />
  </>
);

const Sunflower = () => (
  <>
    {Array.from({ length: 12 }, (_, index) => (
      <ellipse key={index} cx="12" cy="4.6" rx="2" ry="4" fill="#facc15" transform={`rotate(${index * 30} 12 12)`} />
    ))}
    <circle cx="12" cy="12" r="4.6" fill="#78350f" />
    <circle cx="12" cy="12" r="3" fill="#451a03" />
  </>
);

const UaStar = ({ variant }: OrnamentProps) => <path d={STAR} fill={pickColor(['#2563eb', '#facc15'], variant)} />;

const UsFlag = () => (
  <>
    <FlagPole />
    <path d={FLAG} fill="#fafafa" />
    <path
      d="M3 5c3-1.6 6-1.6 9 0s6 1.6 9 0v2.4c-3 1.6-6 1.6-9 0s-6-1.6-9 0zM3 9.8c3-1.6 6-1.6 9 0s6 1.6 9 0v2.4c-3 1.6-6 1.6-9 0s-6-1.6-9 0zM3 14.6c3-1.6 6-1.6 9 0s6 1.6 9 0V17c-3 1.6-6 1.6-9 0s-6-1.6-9 0z"
      fill="#dc2626"
    />
    <path d="M3 5c1.6-.8 3.2-1.2 4.8-1.1 1.4.1 2.2.4 3.2 1v6.2c-1-.6-1.8-.9-3.2-1-1.6-.1-3.2.3-4.8 1.1z" fill="#1d4ed8" />
    <g fill="#fafafa">
      <circle cx="5" cy="6.4" r=".55" />
      <circle cx="7.4" cy="6" r=".55" />
      <circle cx="9.6" cy="6.5" r=".55" />
      <circle cx="6.2" cy="8.4" r=".55" />
      <circle cx="8.6" cy="8.4" r=".55" />
    </g>
  </>
);

// The white star has a blue edge, or it vanishes on a light theme.
const UsStar = ({ variant }: OrnamentProps) => (
  <path d={STAR} fill={pickColor(['#dc2626', '#fafafa', '#2563eb'], variant)} stroke="#1d4ed8" strokeWidth={variant % 3 === 1 ? 1.2 : 0} strokeLinejoin="round" />
);

const TURKEY_FEATHERS = ['#dc2626', '#ea580c', '#f59e0b', '#b45309', '#dc2626', '#ea580c', '#f59e0b'];

const Turkey = () => (
  <>
    {TURKEY_FEATHERS.map((color, index) => (
      <ellipse key={index} cx="12" cy="5" rx="2.6" ry="5.4" fill={color} transform={`rotate(${-72 + index * 24} 12 13)`} />
    ))}
    <ellipse cx="12" cy="15" rx="5.2" ry="5.8" fill="#78350f" />
    <circle cx="12" cy="9.6" r="2.6" fill="#92400e" />
    <circle cx="11.2" cy="9.1" r=".55" fill="#fafafa" />
    <circle cx="12.8" cy="9.1" r=".55" fill="#fafafa" />
    <path d="M11.2 10.4h1.6l-.8 1.4z" fill="#facc15" />
    <path d="M12.5 11c.5.6.6 1.6.1 2.2" stroke="#dc2626" strokeWidth=".9" fill="none" strokeLinecap="round" />
    <path d="M10 20.6v1.8M14 20.6v1.8" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round" />
  </>
);

// A slice of pumpkin pie with a dab of cream.
const Pie = () => (
  <>
    <path d="M3 18.5 20 6.5l1.5 3.2V18.5z" fill="#ea580c" />
    <path d="M3 18.5h18.5V21H3z" fill="#d97706" />
    <path d="M3 18.5 20 6.5l1.5 3.2" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinejoin="round" />
    <path d="M14 13.5c1-1.4 3.4-1.6 4-.2.8-.6 2.2-.2 2 1-.2 1.2-2.4 1.4-3.6 1-1.4.4-3-.4-2.4-1.8z" fill="#fafafa" />
  </>
);

const MapleLeaf = ({ variant }: OrnamentProps) => {
  const color = pickColor(['#ea580c', '#dc2626', '#f59e0b', '#b45309'], variant);
  return <path d={MAPLE} fill={color} stroke={color} strokeWidth="0.6" strokeLinejoin="round" />;
};

const Flower = ({ variant }: OrnamentProps) => {
  const color = pickColor(['#f472b6', '#a78bfa', '#fb923c', '#f9a8d4', '#fb7185'], variant);
  return (
    <>
      {[0, 72, 144, 216, 288].map((angle) => (
        <ellipse key={angle} cx="12" cy="6.2" rx="3.6" ry="5" fill={color} transform={`rotate(${angle} 12 12)`} />
      ))}
      <circle cx="12" cy="12" r="3" fill="#f6c445" />
    </>
  );
};

const Sunglasses = () => (
  <>
    <path d="M1.5 9.2h21" stroke="#f472b6" strokeWidth="1.6" strokeLinecap="round" />
    <path
      d="M2.4 9.2h8.2c0 3.4-1.3 5.6-4.1 5.6S2.4 12.6 2.4 9.2zM13.4 9.2h8.2c0 3.4-1.3 5.6-4.1 5.6s-4.1-2.2-4.1-5.6z"
      fill="#1c1917"
      stroke="#f472b6"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <path d="M4.4 10.6l2 2M15.4 10.6l2 2" stroke="#e7e5e4" strokeWidth="0.9" strokeLinecap="round" opacity="0.7" />
  </>
);

const BeachUmbrella = () => (
  <>
    <path d="M12 11v11" stroke="#a8a29e" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M2 11C2 6 6.5 2.5 12 2.5S22 6 22 11z" fill="#fafafa" />
    <path d="M2 11C2 6 6.5 2.5 12 2.5 9.5 4.5 8.6 8 8.6 11zM12 2.5c2.5 2 3.4 5.5 3.4 8.5H22C22 6 17.5 2.5 12 2.5z" fill="#ef4444" />
    <path d="M2 11q1.6 1.2 3.3 0t3.3 0 3.4 0 3.4 0 3.3 0 3.3 0" fill="none" stroke="#fafafa" strokeWidth="0.9" />
  </>
);

const Cocktail = () => (
  <>
    <path d="M15.5 1.5 12.5 11" stroke="#22c55e" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M3 4.5h18L12 13.5z" fill="#a8a29e" opacity="0.35" />
    <path d="M5.4 6.9h13.2L12 13.5z" fill="#fb923c" />
    <path d="M12 13.5V21M8 21.5h8" stroke="#a8a29e" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="5.6" cy="5" r="2.6" fill="#facc15" />
    <circle cx="5.6" cy="5" r="1.6" fill="none" stroke="#fef08a" strokeWidth="0.6" />
  </>
);

const Book = ({ variant }: OrnamentProps) => (
  <>
    <rect x="4" y="3" width="15" height="18.5" rx="1.2" fill="#e7e5e4" />
    <rect x="3" y="2.5" width="15" height="18" rx="1.2" fill={pickColor(['#2563eb', '#15803d', '#9333ea', '#c2410c'], variant)} />
    <path d="M5.6 2.5v18" stroke="#000" strokeOpacity="0.25" strokeWidth="1.2" />
    <rect x="8.2" y="6.5" width="7" height="2.6" rx="0.5" fill="#fef3c7" />
    <path d="M18 5v15" stroke="#a8a29e" strokeWidth="0.6" />
  </>
);

const RainUmbrella = ({ variant }: OrnamentProps) => (
  <>
    <path d="M12 11.5v7.6c0 1.6 1 2.6 2.3 2.6s2.3-1 2.3-2.6" fill="none" stroke="#a8a29e" strokeWidth="1.5" strokeLinecap="round" />
    <path
      d="M1.5 12C1.5 6.2 6.2 2 12 2s10.5 4.2 10.5 10c-1.2-1.2-2.4-1.2-3.5 0-1.2-1.2-2.3-1.2-3.5 0-1.2-1.2-2.3-1.2-3.5 0-1.2-1.2-2.3-1.2-3.5 0-1.2-1.2-2.3-1.2-3.5 0-1.2-1.2-2.3-1.2-3.5 0z"
      fill={pickColor(['#2563eb', '#eab308', '#7c3aed', '#0d9488'], variant)}
    />
    <path d="M12 2c-2.4 2.2-3.5 6-3.5 10M12 2c2.4 2.2 3.5 6 3.5 10M12 2v10" fill="none" stroke="#000" strokeOpacity="0.22" strokeWidth="0.9" />
  </>
);

const Snowflake = ({ variant }: OrnamentProps) => {
  const color = pickColor(['#38bdf8', '#7dd3fc', '#0ea5e9', '#60a5fa'], variant);
  return (
    <>
      {[0, 60, 120, 180, 240, 300].map((angle) => (
        <path
          key={angle}
          d="M12 12V2.2M12 5.4 9.6 3.4M12 5.4l2.4-2M12 8.6 9.9 7M12 8.6 14.1 7"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </>
  );
};

const DRAWINGS = {
  heart: Heart,
  clover: Clover,
  lantern: Lantern,
  envelope: Envelope,
  crescent: Crescent,
  fanous: Fanous,
  goldStar: GoldStar,
  tree: Tree,
  bauble: Bauble,
  gift: Gift,
  dreidel: Dreidel,
  uaFlag: UaFlag,
  sunflower: Sunflower,
  uaStar: UaStar,
  usFlag: UsFlag,
  usStar: UsStar,
  turkey: Turkey,
  pie: Pie,
  mapleLeaf: MapleLeaf,
  flower: Flower,
  sunglasses: Sunglasses,
  beachUmbrella: BeachUmbrella,
  cocktail: Cocktail,
  book: Book,
  rainUmbrella: RainUmbrella,
  snowflake: Snowflake,
} satisfies Record<HolidayOrnament, React.FC<OrnamentProps>>;

export const HolidayOrnamentIcon = ({ ornament, variant }: { ornament: HolidayOrnament; variant: number }) => {
  const Ornament = DRAWINGS[ornament];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <Ornament variant={variant} />
    </svg>
  );
};
