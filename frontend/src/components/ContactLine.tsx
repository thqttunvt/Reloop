import type { Contact } from '../lib/api';

/** Liên hệ công khai của đối tác (QĐ-34): email bắt buộc, SĐT nếu đã khai trong hồ sơ. */
export function ContactLine({ contact }: { contact?: Contact }) {
  if (!contact?.email && !contact?.phone) return null;
  return (
    <div className="contact-line small">
      {contact.email && (
        <a href={`mailto:${contact.email}`}>
          <span aria-hidden>✉️</span>
          {contact.email}
        </a>
      )}
      {contact.phone && (
        <a href={`tel:${contact.phone}`}>
          <span aria-hidden>📞</span>
          {contact.phone}
        </a>
      )}
    </div>
  );
}
