/** Chọn nhiều giá trị từ một bảng nhãn (danh mục, tình trạng, hình thức bàn giao). */
export function CheckGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Record<string, string>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset className="checks">
      <legend>{label}</legend>
      {Object.entries(options).map(([k, text]) => (
        <label key={k} className="check">
          <input
            type="checkbox"
            checked={value.includes(k)}
            onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((v) => v !== k))}
          />
          {text}
        </label>
      ))}
    </fieldset>
  );
}
