import { useMemo, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View, type ViewStyle } from "react-native";
import { STATUS, withAlpha, type Tokens } from "./theme.client";

export function Card({ tokens, style, children }: { tokens: Tokens; style?: ViewStyle; children: ReactNode }) {
  return (
    <View
      style={[
        {
          backgroundColor: tokens.raised,
          borderColor: tokens.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 14,
          gap: 10,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Chip({
  label,
  selected,
  tokens,
  onPress,
  tone,
}: {
  label: string;
  selected: boolean;
  tokens: Tokens;
  onPress: () => void;
  tone?: string;
}) {
  const active = tone ?? tokens.accent;
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? active : tokens.border,
        backgroundColor: selected ? active : "transparent",
      }}
    >
      <Text style={{ color: selected ? tokens.accentInk : tokens.muted, fontSize: 12 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Button({
  label,
  tokens,
  onPress,
  tone = "default",
  disabled = false,
}: {
  label: string;
  tokens: Tokens;
  onPress: () => void;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
}) {
  const fill = tone === "primary" ? tokens.accent : tone === "danger" ? STATUS.critical : "transparent";
  const filled = tone !== "default";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 11,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        opacity: disabled ? 0.45 : 1,
        borderColor: filled ? fill : tokens.border,
        backgroundColor: fill,
      }}
    >
      <Text style={{ color: filled ? tokens.accentInk : tokens.ink, fontSize: 12, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Small square button for row-level and header-level actions. */
export function IconButton({
  glyph,
  label,
  tokens,
  onPress,
  active = false,
}: {
  glyph: string;
  label?: string;
  tokens: Tokens;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityLabel={label}
      style={{
        paddingHorizontal: label ? 8 : 6,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        borderColor: active ? tokens.accent : tokens.border,
        backgroundColor: active ? tokens.accent : "transparent",
      }}
    >
      <Text style={{ color: active ? tokens.accentInk : tokens.muted, fontSize: 11 }}>{glyph}</Text>
      {label ? (
        <Text style={{ color: active ? tokens.accentInk : tokens.muted, fontSize: 11 }}>{label}</Text>
      ) : null}
    </Pressable>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  tokens,
  style,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  tokens: Tokens;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 9,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.row,
        },
        style,
      ]}
    >
      <Text style={{ color: tokens.muted, fontSize: 12 }}>⌕</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={tokens.muted}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ flex: 1, paddingVertical: 6, color: tokens.ink, fontSize: 12 }}
      />
      {value !== "" ? (
        <Pressable onPress={() => onChange("")} hitSlop={8}>
          <Text style={{ color: tokens.muted, fontSize: 13 }}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export interface TabDescriptor {
  id: string;
  title: string;
  glyph?: string;
  closable?: boolean;
}

export function TabStrip({
  tabs,
  activeId,
  tokens,
  onSelect,
  onClose,
  trailing,
}: {
  tabs: TabDescriptor[];
  activeId: string | null;
  tokens: Tokens;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        borderBottomWidth: 1,
        borderBottomColor: tokens.border,
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onSelect(tab.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderTopLeftRadius: 7,
              borderTopRightRadius: 7,
              backgroundColor: active ? tokens.raised : "transparent",
              borderBottomWidth: 2,
              borderBottomColor: active ? tokens.accent : "transparent",
            }}
          >
            {tab.glyph ? (
              <Text style={{ color: active ? tokens.ink : tokens.muted, fontSize: 11 }}>{tab.glyph}</Text>
            ) : null}
            <Text
              style={{ color: active ? tokens.ink : tokens.muted, fontSize: 12, fontWeight: active ? "600" : "400" }}
              numberOfLines={1}
            >
              {tab.title}
            </Text>
            {tab.closable && onClose ? (
              <Pressable onPress={() => onClose(tab.id)} hitSlop={8}>
                <Text style={{ color: tokens.muted, fontSize: 13 }}>×</Text>
              </Pressable>
            ) : null}
          </Pressable>
        );
      })}
      {trailing}
    </View>
  );
}

/** Fill carries severity; the track is the same hue, lightened. */
export function Meter({ ratio, color, height = 6 }: { ratio: number; color: string; height?: number }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return (
    <View style={{ height, borderRadius: 4, backgroundColor: withAlpha(color, 0.18), overflow: "hidden" }}>
      <View
        style={{
          width: `${clamped * 100}%`,
          height: "100%",
          borderRadius: 4,
          backgroundColor: clamped === 0 ? "transparent" : color,
        }}
      />
    </View>
  );
}

export function StatTile({
  label,
  value,
  note,
  tone,
  tokens,
  compact = false,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: string;
  tokens: Tokens;
  compact?: boolean;
}) {
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: compact ? 78 : 104,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: tokens.border,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 1,
      }}
    >
      <Text style={{ color: tokens.muted, fontSize: 10 }} numberOfLines={1}>
        {label}
      </Text>
      <Text style={{ color: tone ?? tokens.ink, fontSize: compact ? 17 : 20, fontWeight: "600" }}>{value}</Text>
      {note ? (
        <Text style={{ color: tokens.muted, fontSize: 10 }} numberOfLines={1}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

export function Banner({
  tone,
  title,
  lines,
  tokens,
}: {
  tone: "critical" | "warning";
  title: string;
  lines: string[];
  tokens: Tokens;
}) {
  const color = tone === "critical" ? STATUS.critical : STATUS.warning;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: withAlpha(color, 0.5),
        backgroundColor: withAlpha(color, 0.08),
        borderRadius: 9,
        padding: 10,
        gap: 4,
      }}
    >
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>
        {tone === "critical" ? "■" : "▲"} {title}
      </Text>
      {lines.map((line) => (
        <Text key={line} style={{ color: tokens.muted, fontSize: 11 }}>
          {line}
        </Text>
      ))}
    </View>
  );
}


export interface DropdownOption {
  value: string;
  label: string;
  detail?: string;
  /** Small coloured dot before the label, e.g. cluster health. */
  tone?: string;
}

/**
 * Select control. React Native has no native picker, and an absolutely
 * positioned popover would be clipped by the panes it opens inside, so this
 * uses a Modal sheet — which also behaves correctly on touch.
 */
export function Dropdown({
  value,
  options,
  onSelect,
  tokens,
  title,
  placeholder = "Select…",
  searchable = false,
  minWidth = 150,
  emphasis = false,
}: {
  value: string | null;
  options: DropdownOption[];
  onSelect: (value: string) => void;
  tokens: Tokens;
  title: string;
  placeholder?: string;
  searchable?: boolean;
  minWidth?: number;
  emphasis?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = options.find((option) => option.value === value) ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return options;
    return options.filter((option) => `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(needle));
  }, [options, query]);

  return (
    <>
      <Pressable
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          minWidth,
          paddingHorizontal: 10,
          paddingVertical: emphasis ? 7 : 5,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.raised,
        }}
      >
        {selected?.tone ? <Text style={{ color: selected.tone, fontSize: 9 }}>●</Text> : null}
        <Text
          style={{
            color: selected ? tokens.ink : tokens.muted,
            fontSize: emphasis ? 14 : 12,
            fontWeight: emphasis ? "600" : "400",
            flex: 1,
          }}
          numberOfLines={1}
        >
          {selected?.label ?? placeholder}
        </Text>
        <Text style={{ color: tokens.muted, fontSize: 10 }}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center", padding: 24 }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: "100%",
              maxWidth: 420,
              maxHeight: "80%",
              borderRadius: 12,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.surface,
              overflow: "hidden",
            }}
          >
            <View style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: tokens.border, gap: 8 }}>
              <Text style={{ color: tokens.ink, fontSize: 13, fontWeight: "600" }}>{title}</Text>
              {searchable ? (
                <SearchField value={query} onChange={setQuery} placeholder="Filter…" tokens={tokens} />
              ) : null}
            </View>
            <ScrollView style={{ maxHeight: 380 }}>
              {filtered.length === 0 ? (
                <Text style={{ color: tokens.muted, fontSize: 12, padding: 14 }}>Nothing matches.</Text>
              ) : (
                filtered.map((option) => {
                  const active = option.value === value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => {
                        onSelect(option.value);
                        setOpen(false);
                      }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 9,
                        backgroundColor: active ? tokens.rowSelected : "transparent",
                      }}
                    >
                      {option.tone ? <Text style={{ color: option.tone, fontSize: 9 }}>●</Text> : null}
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: tokens.ink, fontSize: 12 }} numberOfLines={1}>
                          {option.label}
                        </Text>
                        {option.detail ? (
                          <Text style={{ color: tokens.muted, fontSize: 10 }} numberOfLines={1}>
                            {option.detail}
                          </Text>
                        ) : null}
                      </View>
                      {active ? <Text style={{ color: tokens.accent, fontSize: 12 }}>✓</Text> : null}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/** Small uppercase label that opens a group of settings or list rows. */
export function SectionLabel({ text, tokens, style }: { text: string; tokens: Tokens; style?: ViewStyle }) {
  return (
    <View style={style}>
      <Text
        style={{
          color: tokens.muted,
          fontSize: 10,
          fontWeight: "700",
          letterSpacing: 0.7,
          textTransform: "uppercase",
        }}
      >
        {text}
      </Text>
    </View>
  );
}

export function FieldRow({
  label,
  hint,
  tokens,
  children,
}: {
  label: string;
  hint?: string;
  tokens: Tokens;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={{ color: tokens.ink, fontSize: 12, fontWeight: "500" }}>{label}</Text>
      {hint ? <Text style={{ color: tokens.muted, fontSize: 11 }}>{hint}</Text> : null}
      {children}
    </View>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  tokens,
  mono = false,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  tokens: Tokens;
  mono?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={tokens.muted}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        borderWidth: 1,
        borderColor: tokens.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        color: tokens.ink,
        fontSize: 12,
        ...(mono ? { fontFamily: tokens.mono } : {}),
      }}
    />
  );
}

export function Toggle({
  label,
  hint,
  value,
  onChange,
  tokens,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  tokens: Tokens;
}) {
  return (
    <Pressable onPress={() => onChange(!value)} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
      <View
        style={{
          width: 34,
          height: 20,
          borderRadius: 10,
          padding: 2,
          backgroundColor: value ? tokens.accent : withAlpha(tokens.ink, 0.15),
          justifyContent: "center",
          alignItems: value ? "flex-end" : "flex-start",
        }}
      >
        <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: value ? tokens.accentInk : tokens.muted }} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: tokens.ink, fontSize: 12, fontWeight: "500" }}>{label}</Text>
        {hint ? <Text style={{ color: tokens.muted, fontSize: 11 }}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}
