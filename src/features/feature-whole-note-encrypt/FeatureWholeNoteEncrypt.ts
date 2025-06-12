import MeldEncrypt from "src/main";
import { IMeldEncryptPluginFeature } from "../IMeldEncryptPluginFeature";
import { EncryptedMarkdownView } from "./EncryptedMarkdownView";
import { MarkdownView, Notice,TFolder, normalizePath, moment, TFile } from "obsidian";
import PluginPasswordModal from "src/PluginPasswordModal";
import { IPasswordAndHint, SessionPasswordService } from "src/services/SessionPasswordService";
import { FileDataHelper, JsonFileEncoding } from "src/services/FileDataHelper";
import { ENCRYPTED_FILE_EXTENSIONS, ENCRYPTED_FILE_EXTENSION_DEFAULT } from "src/services/Constants";

export default class FeatureWholeNoteEncryptV2 implements IMeldEncryptPluginFeature {

	plugin: MeldEncrypt;

	private statusIndicator: HTMLElement;

	async onload( plugin: MeldEncrypt ) {
		this.plugin = plugin;
		//this.settings = settings.featureWholeNoteEncrypt;
		
		this.plugin.addRibbonIcon( 'file-lock-2', 'New encrypted note', async (ev)=>{
			await this.processCreateNewEncryptedNoteCommand( this.getDefaultFileFolder() );
		});

		this.plugin.addCommand({
			id: 'meld-encrypt-create-new-note',
			name: 'Create new encrypted note',
			icon: 'file-lock-2',
			callback: async () => await this.processCreateNewEncryptedNoteCommand( this.getDefaultFileFolder() ),
		});

		
		this.plugin.registerEvent(
			this.plugin.app.workspace.on( 'file-menu', (menu, file) => {
				if (file instanceof TFolder){
					menu.addItem( (item) => {
						item
							.setTitle('New encrypted note')
							.setIcon('file-lock-2')
							.onClick( () => this.processCreateNewEncryptedNoteCommand( file ) );
						}
					);
					menu.addItem( (item) => {
						item
							.setTitle('Encrypt folder')
							.setIcon('lock')
							.onClick( async () => await this.processEncryptFolderCommand(file) );
						}
					);
					menu.addItem( (item) => {
						item
							.setTitle('Decrypt folder')
							.setIcon('unlock')
							.onClick( async () => await this.processDecryptFolderCommand(file) );
						}
					);
				}
			})
		);

		// configure status indicator
		this.statusIndicator = this.plugin.addStatusBarItem();
		this.statusIndicator.hide();
		this.statusIndicator.setText('🔐');

		// editor context menu
		this.plugin.registerEvent( this.plugin.app.workspace.on('editor-menu', (menu, editor, view) => {
			if( view.file == null || !ENCRYPTED_FILE_EXTENSIONS.includes( view.file.extension ) ){
				return;
			}
			if (view instanceof EncryptedMarkdownView){
				menu.addItem( (item) => {
					item
						.setTitle('Change Password')
						.setIcon('key-round')
						.onClick( async () => await view.changePassword() );
					}
				);
				menu.addItem( (item) => {
					item
						.setTitle('Lock & Close')
						.setIcon('lock')
						.onClick( () => this.lockAndClose(view) );
					}
				);
			}
		}));

		this.plugin.registerEvent( this.plugin.app.workspace.on('file-menu', (menu, file) => {
			if ( !(file instanceof TFile) ){
				return
			}
			if( !ENCRYPTED_FILE_EXTENSIONS.includes( file.extension ) ){
				return;
			}

			const view = this.plugin.app.workspace.getActiveViewOfType( EncryptedMarkdownView );
			if (view == null || view.file != file){
				return;
			}

			menu.addItem( (item) => {
				item
					.setTitle('Change Password')
					.setIcon('key-round')
					.onClick( async () => await view.changePassword() );
				}
			);
			menu.addItem( (item) => {
				item
					.setTitle('Lock & Close')
					.setIcon('lock')
					.onClick( () => this.lockAndClose(view)  );
				}
			);
		}))


		// register view
		this.plugin.registerView( EncryptedMarkdownView.VIEW_TYPE, (leaf) => new EncryptedMarkdownView(leaf) );
		this.plugin.registerExtensions( ENCRYPTED_FILE_EXTENSIONS, EncryptedMarkdownView.VIEW_TYPE );

		// show status indicator for encrypted files, hide for others
		this.plugin.registerEvent( this.plugin.app.workspace.on('layout-change', () => {
			const view = this.plugin.app.workspace.getActiveViewOfType(EncryptedMarkdownView);
			if (view == null){
				this.statusIndicator.hide();
				return;
			}
			this.statusIndicator.show();
		}));

		// make sure the view is the right type
		this.plugin.registerEvent(

            this.plugin.app.workspace.on('active-leaf-change', async (leaf) => {
				if ( leaf == null ){
					return;
				}
				
				if ( leaf.view instanceof EncryptedMarkdownView ){
					// correct view already active
					return;
				}

				if ( leaf.view instanceof MarkdownView ){

					const file = leaf.view.file;
					if ( file == null ){
						return;
					}
					
					if ( ENCRYPTED_FILE_EXTENSIONS.includes( file.extension ) ){
						// file is encrypted but has the wrong view type
						const viewState = leaf.getViewState();
						viewState.type = EncryptedMarkdownView.VIEW_TYPE;
						
						await leaf.setViewState( viewState );

						return;
					}

				}

			} )
        )

	}

	private lockAndClose( view: EncryptedMarkdownView ) : void {
		view.detachSafely();
		if ( view.file != null ){
			SessionPasswordService.clearForFile( view.file );
		}
	}

	private getDefaultFileFolder() : TFolder {
		const activeFile = this.plugin.app.workspace.getActiveFile();

		if (activeFile != null){
			return this.plugin.app.fileManager.getNewFileParent(activeFile.path);
		}else{
			return this.plugin.app.fileManager.getNewFileParent('');
		}
	}

	private async processCreateNewEncryptedNoteCommand( parentFolder: TFolder ) : Promise<void> {
		
		const newFilename = moment().format( `[Untitled] YYYYMMDD hhmmss[.${ENCRYPTED_FILE_EXTENSION_DEFAULT}]`);
		const newFilepath = normalizePath( parentFolder.path + "/" + newFilename );
		
		let pwh : IPasswordAndHint | undefined;
		
		if ( SessionPasswordService.getLevel() == SessionPasswordService.LevelExternalFile ){
			// if using external file for password, try and get the password
			pwh = await SessionPasswordService.getByPathAsync( newFilepath );
		}

		// if the password is unknown, prompt for it
		if ( !pwh ){
			// prompt for password
			const pwm = new PluginPasswordModal(
				this.plugin.app,
				'Please provide a password for encryption',
				true,
				true,
				await SessionPasswordService.getByPathAsync( newFilepath )
			);
			
			try{
				pwh = await pwm.openAsync();
			}catch(e){
				return; // cancelled
			}	
		}

		// create the new file
		const fileData = await FileDataHelper.encrypt( pwh.password, pwh.hint, '' )
		const fileContents = JsonFileEncoding.encode( fileData );
		const file = await this.plugin.app.vault.create( newFilepath, fileContents );
		
		// cache the password
		SessionPasswordService.putByFile( pwh, file );

		// open the file
		const leaf = this.plugin.app.workspace.getLeaf( true );
		await leaf.openFile( file );

	}

	private async processEncryptFolderCommand(folder: TFolder): Promise<void> {
		const files = this.plugin.app.vault.getFiles().filter(f => 
			f.path.startsWith(folder.path) && 
			f.extension === 'md' &&
			!ENCRYPTED_FILE_EXTENSIONS.includes(f.extension)
		);

		const pwm = new PluginPasswordModal(
			this.plugin.app,
			'Please provide a password for encryption',
			true,
			true,
			{ password: '', hint: '' }
		);
		
		let pwh: IPasswordAndHint;
		try {
			pwh = await pwm.openAsync();
		} catch(e) {
			return; // cancelled
		}

		for (const file of files) {
			try {
				const content = await this.plugin.app.vault.read(file);
				const fileData = await FileDataHelper.encrypt(pwh.password, pwh.hint, content);
				const fileContents = JsonFileEncoding.encode(fileData);
				const newPath = file.path + '.' + ENCRYPTED_FILE_EXTENSION_DEFAULT;
				await this.plugin.app.vault.rename(file, newPath);
				await this.plugin.app.vault.modify(file, fileContents);
				SessionPasswordService.putByFile(pwh, file);
			} catch(e) {
				console.error(`Failed to encrypt file ${file.path}:`, e);
			}
		}

		new Notice( '🔐 All Notes under the folder were encrypted 🔓' );
	}

	private async processDecryptFolderCommand(folder: TFolder): Promise<void> {
		const files = this.plugin.app.vault.getFiles().filter(f => 
			f.path.startsWith(folder.path) && 
			f.extension === 'mdenc' &&
			ENCRYPTED_FILE_EXTENSIONS.includes(f.extension)
		);

		// prompt for password
		const pwm = new PluginPasswordModal(
			this.plugin.app,
			'Please provide password for decryption',
			false,
			false,
			{ password: '', hint: '' }
		);
		
		let pwh: IPasswordAndHint;
		try {
			pwh = await pwm.openAsync();
		} catch(e) {
			return; // cancelled
		}

		for (const file of files) {
			try {
				const content = await this.plugin.app.vault.read(file);
				const fileData = JsonFileEncoding.decode(content);
				const decrypted = await FileDataHelper.decrypt(fileData, pwh.password);
				
				const newPath = file.path.replace(/\.\w+$/, '');
				await this.plugin.app.vault.rename(file, newPath);
				// 由于 decrypted 可能为 null，这里做一个非空检查，确保传递给 vault.modify 的参数是 string 类型
				if (decrypted !== null) {
					await this.plugin.app.vault.modify(file, decrypted);
				}
			} catch(e) {
				console.error(`Failed to decrypt file ${file.path}:`, e);
			}
		}

		new Notice( '🔐 All Notes under the folder were decrypted 🔓' );
	}

	onunload() {
		this.plugin.app.workspace.detachLeavesOfType(EncryptedMarkdownView.VIEW_TYPE);
	}

	buildSettingsUi(containerEl: HTMLElement, saveSettingCallback: () => Promise<void>): void {
		//throw new Error("Method not implemented.");
	}

}
