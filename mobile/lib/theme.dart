import 'package:flutter/material.dart';

/// Direction artistique LogisticTrack : sobre, couleurs unies, bleu en accent.
class Palette {
  static const blue = Color(0xFF2563EB);
  static const night = Color(0xFF14213D);
  static const blueSoft = Color(0xFFEFF6FF);
  static const bg = Color(0xFFF5F7FA);
  static const line = Color(0xFFE6EAF0);
  static const muted = Color(0xFF64748B);
  static const green = Color(0xFF0F7A4F);
  static const greenSoft = Color(0xFFE9F8F1);
  static const orange = Color(0xFF9A5B0A);
  static const orangeSoft = Color(0xFFFDF4E7);
  static const red = Color(0xFFB92F2F);
  static const redSoft = Color(0xFFFDEEEE);
  // États de mission, identiques au web.
  static const blueText = Color(0xFF1E4FBB);
  static const teal = Color(0xFF0D6158);
  static const tealSoft = Color(0xFFE0F7F3);
  static const lime = Color(0xFF47640F);
  static const limeSoft = Color(0xFFEEF8D8);
  static const rose = Color(0xFFA51A52);
  static const roseSoft = Color(0xFFFDEAF1);
  static const slate = Color(0xFF475569);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: Palette.blue, brightness: Brightness.light).copyWith(primary: Palette.blue, onSurface: Palette.night, surface: Colors.white, surfaceTint: Colors.transparent, error: Palette.red);
  final radius = BorderRadius.circular(12);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: Palette.bg,
    splashFactory: InkRipple.splashFactory,
    appBarTheme: const AppBarTheme(backgroundColor: Colors.white, foregroundColor: Palette.night, elevation: 0, scrolledUnderElevation: 0, centerTitle: false, titleTextStyle: TextStyle(color: Palette.night, fontSize: 17, fontWeight: FontWeight.w600), shape: Border(bottom: BorderSide(color: Palette.line))),
    cardTheme: CardThemeData(color: Colors.white, elevation: 0, margin: EdgeInsets.zero, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: Palette.line))),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(backgroundColor: Palette.blue, minimumSize: const Size.fromHeight(50), shape: RoundedRectangleBorder(borderRadius: radius), textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(foregroundColor: Palette.night, minimumSize: const Size.fromHeight(48), side: const BorderSide(color: Palette.line), shape: RoundedRectangleBorder(borderRadius: radius), textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500))),
    inputDecorationTheme: InputDecorationTheme(filled: true, fillColor: Colors.white, border: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: Palette.line)), enabledBorder: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: Palette.line)), focusedBorder: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: Palette.blue, width: 1.5)), contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14)),
    navigationBarTheme: NavigationBarThemeData(backgroundColor: Colors.white, indicatorColor: Palette.blueSoft, surfaceTintColor: Colors.transparent, labelTextStyle: WidgetStateProperty.all(const TextStyle(fontSize: 12, fontWeight: FontWeight.w500))),
    dividerTheme: const DividerThemeData(color: Palette.line, thickness: 1, space: 1),
  );
}
