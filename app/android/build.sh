#!/usr/bin/env bash
# Monta o APK do MarketMe sem Gradle, usando as ferramentas do Android SDK
# empacotadas pelo Debian/Ubuntu:
#   apt install android-sdk-build-tools android-sdk-platform-23 \
#               apksigner zipalign dalvik-exchange default-jdk
#
# Saída: app/android/build/marketme-debug.apk
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
DX="${DX:-dalvik-exchange}"
BUILD="$DIR/build"

[ -f "$ANDROID_JAR" ] || { echo "android.jar não encontrado em $ANDROID_JAR"; exit 1; }

rm -rf "$BUILD"
mkdir -p "$BUILD/obj" "$BUILD/apk" "$BUILD/assets"

echo "==> Copiando SPA para assets/"
cp -r "$DIR/../www" "$BUILD/assets/www"

echo "==> Compilando Java (javac --release 8)"
find "$DIR/src" -name '*.java' -print0 \
  | xargs -0 javac --release 8 -classpath "$ANDROID_JAR" -d "$BUILD/obj" \
      -Xlint:-options 2>&1 | grep -v '^Picked up' || true

echo "==> Gerando classes.dex"
"$DX" --dex --min-sdk-version=23 --output="$BUILD/apk/classes.dex" "$BUILD/obj" \
  2>&1 | grep -v '^Picked up' || true
[ -f "$BUILD/apk/classes.dex" ] || { echo "falha ao gerar classes.dex"; exit 1; }

echo "==> Empacotando recursos (aapt)"
aapt package -f \
  -M "$DIR/AndroidManifest.xml" \
  -S "$DIR/res" \
  -A "$BUILD/assets" \
  -I "$ANDROID_JAR" \
  -F "$BUILD/marketme.unsigned.apk"

(cd "$BUILD/apk" && aapt add "$BUILD/marketme.unsigned.apk" classes.dex >/dev/null)

echo "==> Alinhando (zipalign)"
zipalign -f 4 "$BUILD/marketme.unsigned.apk" "$BUILD/marketme.aligned.apk"

KEYSTORE="$DIR/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  echo "==> Gerando keystore de debug"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias marketme-debug -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=MarketMe Debug,O=MarketMe,C=BR" 2>&1 | grep -v '^Picked up' || true
fi

echo "==> Assinando (apksigner)"
apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out "$BUILD/marketme-debug.apk" "$BUILD/marketme.aligned.apk"

rm -f "$BUILD/marketme.unsigned.apk" "$BUILD/marketme.aligned.apk" \
      "$BUILD/marketme-debug.apk.idsig"

echo "==> OK: $BUILD/marketme-debug.apk"
