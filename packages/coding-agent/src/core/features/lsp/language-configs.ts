/** Configuration for a language's LSP server, runtime, and detection. */
export interface LanguageConfig {
	/** Display name */
	name: string;

	/** How to detect this language in a project */
	detect: {
		/** File extensions (e.g., [".cs", ".csproj"]) */
		extensions: string[];
		/** Marker files whose presence confirms this language (e.g., ["*.csproj", "*.sln"]) */
		markerFiles?: string[];
	};

	/** Runtime prerequisite check */
	runtime: {
		/** Command to check (e.g., "dotnet") */
		command: string;
		/** Args for version check (e.g., ["--version"]) */
		versionArgs: string[];
		/** Message shown when runtime is missing */
		installHint: string;
	};

	/** LSP server info */
	server: {
		/** Display name */
		name: string;
		/** Executable command */
		command: string;
		/** Startup arguments */
		args: string[];
		/** Command to check if installed */
		checkCommand: string;
		/** Command to install (empty if not auto-installable) */
		installCommand: string;
		/** Whether auto-install is supported */
		autoInstallable: boolean;
		/** Manual install instructions (shown when autoInstallable is false) */
		manualInstallHint?: string;
	};

	/** LSP language identifier (e.g., "csharp", "typescript") */
	languageId: string;
}

// ---------------------------------------------------------------------------
// Tier 1: Auto-installable languages
// ---------------------------------------------------------------------------

export const TIER1_CONFIGS: Record<string, LanguageConfig> = {
	csharp: {
		name: "C#",
		detect: {
			extensions: [".cs"],
			markerFiles: ["*.csproj", "*.sln"],
		},
		runtime: {
			command: "dotnet",
			versionArgs: ["--version"],
			installHint: "Install .NET SDK: https://dotnet.microsoft.com/download",
		},
		server: {
			name: "OmniSharp",
			command: "OmniSharp",
			args: ["-lsp", "--stdio"],
			checkCommand: "OmniSharp --version",
			installCommand: "dotnet tool install -g omnisharp",
			autoInstallable: true,
		},
		languageId: "csharp",
	},

	typescript: {
		name: "TypeScript",
		detect: {
			extensions: [".ts", ".tsx"],
			markerFiles: ["tsconfig.json"],
		},
		runtime: {
			command: "node",
			versionArgs: ["--version"],
			installHint: "Install Node.js: https://nodejs.org",
		},
		server: {
			name: "typescript-language-server",
			command: "typescript-language-server",
			args: ["--stdio"],
			checkCommand: "typescript-language-server --version",
			installCommand: "npm install -g typescript-language-server typescript",
			autoInstallable: true,
		},
		languageId: "typescript",
	},

	javascript: {
		name: "JavaScript",
		detect: {
			extensions: [".js", ".jsx", ".mjs"],
			markerFiles: ["package.json"],
		},
		runtime: {
			command: "node",
			versionArgs: ["--version"],
			installHint: "Install Node.js: https://nodejs.org",
		},
		server: {
			name: "typescript-language-server",
			command: "typescript-language-server",
			args: ["--stdio"],
			checkCommand: "typescript-language-server --version",
			installCommand: "npm install -g typescript-language-server typescript",
			autoInstallable: true,
		},
		languageId: "javascript",
	},

	python: {
		name: "Python",
		detect: {
			extensions: [".py"],
			markerFiles: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
		},
		runtime: {
			command: "python3",
			versionArgs: ["--version"],
			installHint: "Install Python: https://python.org/downloads",
		},
		server: {
			name: "pylsp",
			command: "pylsp",
			args: [],
			checkCommand: "pylsp --version",
			installCommand: "pip3 install python-lsp-server",
			autoInstallable: true,
		},
		languageId: "python",
	},

	go: {
		name: "Go",
		detect: {
			extensions: [".go"],
			markerFiles: ["go.mod"],
		},
		runtime: {
			command: "go",
			versionArgs: ["version"],
			installHint: "Install Go: https://go.dev/dl",
		},
		server: {
			name: "gopls",
			command: "gopls",
			args: ["serve"],
			checkCommand: "gopls version",
			installCommand: "go install golang.org/x/tools/gopls@latest",
			autoInstallable: true,
		},
		languageId: "go",
	},

	rust: {
		name: "Rust",
		detect: {
			extensions: [".rs"],
			markerFiles: ["Cargo.toml"],
		},
		runtime: {
			command: "rustc",
			versionArgs: ["--version"],
			installHint: "Install Rust: https://rustup.rs",
		},
		server: {
			name: "rust-analyzer",
			command: "rust-analyzer",
			args: [],
			checkCommand: "rust-analyzer --version",
			installCommand: "rustup component add rust-analyzer",
			autoInstallable: true,
		},
		languageId: "rust",
	},
};

// ---------------------------------------------------------------------------
// Tier 2: Manual-only languages (detect + show instructions)
// ---------------------------------------------------------------------------

export const TIER2_CONFIGS: Record<string, LanguageConfig> = {
	java: {
		name: "Java",
		detect: {
			extensions: [".java"],
			markerFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
		},
		runtime: {
			command: "java",
			versionArgs: ["-version"],
			installHint: "Install JDK: https://adoptium.net",
		},
		server: {
			name: "jdtls",
			command: "jdtls",
			args: [],
			checkCommand: "jdtls --version",
			installCommand: "",
			autoInstallable: false,
			manualInstallHint:
				"Eclipse JDT Language Server requires manual setup.\n" +
				"See: https://github.com/eclipse-jdtls/eclipse.jdt.ls#installation",
		},
		languageId: "java",
	},

	cpp: {
		name: "C/C++",
		detect: {
			extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
			markerFiles: ["CMakeLists.txt", "Makefile", "meson.build"],
		},
		runtime: {
			command: "gcc",
			versionArgs: ["--version"],
			installHint: "Install a C/C++ compiler (gcc, clang)",
		},
		server: {
			name: "clangd",
			command: "clangd",
			args: ["--stdio"],
			checkCommand: "clangd --version",
			installCommand: "",
			autoInstallable: false,
			manualInstallHint:
				"Install clangd:\n  macOS: brew install llvm\n  Ubuntu: apt install clangd\n  Windows: choco install llvm",
		},
		languageId: "cpp",
	},

	ruby: {
		name: "Ruby",
		detect: {
			extensions: [".rb"],
			markerFiles: ["Gemfile"],
		},
		runtime: {
			command: "ruby",
			versionArgs: ["--version"],
			installHint: "Install Ruby: https://ruby-lang.org",
		},
		server: {
			name: "solargraph",
			command: "solargraph",
			args: ["stdio"],
			checkCommand: "solargraph --version",
			installCommand: "gem install solargraph",
			autoInstallable: false,
			manualInstallHint: "Run: gem install solargraph",
		},
		languageId: "ruby",
	},

	php: {
		name: "PHP",
		detect: {
			extensions: [".php"],
			markerFiles: ["composer.json"],
		},
		runtime: {
			command: "php",
			versionArgs: ["--version"],
			installHint: "Install PHP: https://php.net",
		},
		server: {
			name: "intelephense",
			command: "intelephense",
			args: ["--stdio"],
			checkCommand: "intelephense --version",
			installCommand: "npm install -g intelephense",
			autoInstallable: false,
			manualInstallHint: "Run: npm install -g intelephense",
		},
		languageId: "php",
	},

	swift: {
		name: "Swift",
		detect: {
			extensions: [".swift"],
			markerFiles: ["Package.swift"],
		},
		runtime: {
			command: "swift",
			versionArgs: ["--version"],
			installHint: "Install Xcode or Swift toolchain: https://swift.org/download",
		},
		server: {
			name: "sourcekit-lsp",
			command: "sourcekit-lsp",
			args: [],
			checkCommand: "sourcekit-lsp --help",
			installCommand: "",
			autoInstallable: false,
			manualInstallHint: "sourcekit-lsp comes with Xcode. Install Xcode from the App Store.",
		},
		languageId: "swift",
	},

	kotlin: {
		name: "Kotlin",
		detect: {
			extensions: [".kt", ".kts"],
			markerFiles: ["build.gradle.kts"],
		},
		runtime: {
			command: "kotlin",
			versionArgs: ["-version"],
			installHint: "Install Kotlin: https://kotlinlang.org/docs/command-line.html",
		},
		server: {
			name: "kotlin-language-server",
			command: "kotlin-language-server",
			args: [],
			checkCommand: "kotlin-language-server --version",
			installCommand: "",
			autoInstallable: false,
			manualInstallHint:
				"Download from: https://github.com/fwcd/kotlin-language-server/releases\nExtract and add to PATH.",
		},
		languageId: "kotlin",
	},
};

// ---------------------------------------------------------------------------
// All configs combined
// ---------------------------------------------------------------------------

export const ALL_CONFIGS: Record<string, LanguageConfig> = {
	...TIER1_CONFIGS,
	...TIER2_CONFIGS,
};

// ---------------------------------------------------------------------------
// File extension → language key mapping (built once at module load)
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {};
for (const [key, config] of Object.entries(ALL_CONFIGS)) {
	for (const ext of config.detect.extensions) {
		// First config wins for shared extensions
		if (!EXT_TO_LANG[ext]) {
			EXT_TO_LANG[ext] = key;
		}
	}
}

/** Get the language config key for a file path based on its extension. */
export function getLanguageKeyForFile(filePath: string): string | undefined {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return undefined;
	const ext = filePath.slice(dot);
	return EXT_TO_LANG[ext];
}

/** Get the LSP language identifier for a file path. */
export function getLanguageIdForFile(filePath: string): string | undefined {
	const key = getLanguageKeyForFile(filePath);
	if (!key) return undefined;
	return ALL_CONFIGS[key]?.languageId;
}
