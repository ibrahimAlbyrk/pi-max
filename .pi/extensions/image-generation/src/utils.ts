export function mimeTypeFromExtension(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() || "";
	switch (ext) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return "image/png";
	}
}
