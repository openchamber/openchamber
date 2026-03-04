const pad2 = (value: number): string => String(value).padStart(2, '0');

const isSameDay = (left: Date, right: Date): boolean => {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
};

const isYesterday = (date: Date, now: Date): boolean => {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return isSameDay(date, yesterday);
};

const isValidTimestamp = (timestamp: number): boolean => {
    return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime());
};

export const formatTimestampForDisplay = (timestamp: number): string => {
    if (!isValidTimestamp(timestamp)) {
        return '';
    }

    const date = new Date(timestamp);
    const now = new Date();

    const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

    if (isSameDay(date, now)) {
        return timePart;
    }

    if (isYesterday(date, now)) {
        return `Yesterday ${timePart}`;
    }

    const monthPart = date.toLocaleString(undefined, { month: 'short' });
    const dayPart = date.getDate();
    const datePart = `${monthPart} ${dayPart}`;

    if (date.getFullYear() === now.getFullYear()) {
        return `${datePart}, ${timePart}`;
    }

    return `${datePart}, ${date.getFullYear()}, ${timePart}`;
};
