type DateInput = Date | string | number;

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Business calendar dates never depend on the VPS's local timezone. */
export function dhakaDate(value: DateInput = new Date()): string {
  return dateFormatter.format(new Date(value));
}

export function dhakaMonth(value: DateInput = new Date()): string {
  return dhakaDate(value).slice(0, 7);
}

export function dhakaMinutes(value: DateInput): number {
  const parts = timeFormatter.formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === 'hour')!.value);
  const minute = Number(parts.find((part) => part.type === 'minute')!.value);
  return hour * 60 + minute;
}
