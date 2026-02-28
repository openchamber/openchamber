const pad2 = (value: number): string => String(value).padStart(2, '0');

const isSameDay = (left: Date, right: Date): boolean => {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
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

    const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

    if (isSameDay(date, now)) {
        return timePart;
    }

    const yearPart = String(date.getFullYear()).slice(-2);
    const monthPart = pad2(date.getMonth() + 1);
    const dayPart = pad2(date.getDate());

    return `${yearPart}-${monthPart}-${dayPart} ${timePart}`;
};
